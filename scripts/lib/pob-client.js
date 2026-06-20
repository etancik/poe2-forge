"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const {
  REPOSITORY_ROOT,
  configPathValue,
  loadPortableConfig,
  orderedValue,
} = require("./portable-config");

const DEFAULT_CURRENT = null;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function resolveRuntime(input = {}) {
  const options = typeof input === "string"
    ? { manifestPath: input }
    : (input || {});
  const config = loadPortableConfig(options.configPath);
  let runtime = orderedValue({
    explicit: options.runtimeDir,
    config,
    configKey: "pobRuntime",
    environment: process.env.POB2_RUNTIME,
  });
  let manifestPath = orderedValue({
    explicit: options.manifestPath || options.currentPath,
    config,
    configKey: "pobRuntimeManifest",
    environment: process.env.POB2_RUNTIME_MANIFEST,
  });
  if (!runtime && !manifestPath) {
    manifestPath = [
      path.join(REPOSITORY_ROOT, "external", "pob2-api", "current.json"),
      path.join(process.cwd(), "external", "pob2-api", "current.json"),
    ].find(fs.existsSync);
  }
  let current = {};
  if (manifestPath) {
    manifestPath = path.resolve(manifestPath);
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`PoB runtime manifest not found: ${manifestPath}`);
    }
    current = readJson(manifestPath);
    if (!runtime && current.runtime) {
      runtime = path.resolve(path.dirname(manifestPath), current.runtime);
    }
  }
  if (!runtime) {
    throw new Error(
      "PoB runtime was not found. Pass --pob-runtime/--current-runtime, " +
      "set POB2_RUNTIME or POB2_RUNTIME_MANIFEST, add pobRuntime or " +
      "pobRuntimeManifest to config.local.json, or place a manifest at " +
      "external/pob2-api/current.json.",
    );
  }
  runtime = path.resolve(runtime);
  const configuredExe = options.executable ||
    process.env.POB2_EXECUTABLE ||
    configPathValue(config, "pobExecutable");
  const configuredWrapper = options.wrapper ||
    process.env.POB2_WRAPPER ||
    configPathValue(config, "pobWrapper");
  const exe = configuredExe
    ? path.resolve(configuredExe)
    : path.join(runtime, "Path of Building-PoE2.exe");
  const wrapper = configuredWrapper
    ? path.resolve(configuredWrapper)
    : path.join(runtime, "HeadlessWrapper.lua");
  if (!fs.existsSync(exe) || !fs.existsSync(wrapper)) {
    throw new Error(
      `Invalid PoB runtime. Expected executable at ${exe} and wrapper at ` +
      `${wrapper}. Configure pobExecutable/pobWrapper when using other names.`,
    );
  }
  return { ...current, runtime, exe, wrapper, manifestPath };
}

function setXmlConfigValue(xml, tag, name, attribute, value) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<${tag}\\b(?=[^>]*\\bname="${escaped}")[^>]*/>`,
    "i",
  );
  if (pattern.test(xml)) {
    return xml.replace(pattern, (entry) => {
      const valuePattern = new RegExp(`\\b${attribute}="[^"]*"`, "i");
      if (valuePattern.test(entry)) {
        return entry.replace(valuePattern, `${attribute}="${value}"`);
      }
      return entry.replace("/>", ` ${attribute}="${value}"/>`);
    });
  }
  const inserted = `\n\t\t\t<${tag} name="${name}" ${attribute}="${value}"/>`;
  return xml.replace(/(<ConfigSet id="1"[^>]*>)/i, `$1${inserted}`);
}

function applyXmlScenario(xml, scenario = {}) {
  let result = xml;
  for (const [name, value] of Object.entries(scenario.placeholders || {})) {
    result = setXmlConfigValue(result, "Placeholder", name, "number", value);
  }
  for (const [name, value] of Object.entries(scenario.inputs || {})) {
    result = setXmlConfigValue(result, "Input", name, "number", value);
  }
  return result;
}

class PobClient {
  constructor(runtimeMeta) {
    this.meta = runtimeMeta;
    this.buffer = "";
    this.waiters = [];
    this.stderr = "";
    const wrapperArg = path.dirname(runtimeMeta.wrapper) === runtimeMeta.runtime
      ? path.basename(runtimeMeta.wrapper)
      : runtimeMeta.wrapper;
    this.proc = spawn(runtimeMeta.exe, [wrapperArg, "--stdio"], {
      cwd: runtimeMeta.runtime,
      env: { ...process.env, POB_API_STDIO: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc.stdout.on("data", (data) => this.onData(data.toString()));
    this.proc.stderr.on("data", (data) => {
      this.stderr += data.toString();
    });
    this.proc.on("exit", (code) => {
      while (this.waiters.length) {
        this.waiters.shift().reject(
          new Error(`PoB2 exited with code ${code}: ${this.stderr.trim()}`),
        );
      }
    });
  }

  onData(data) {
    this.buffer += data;
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      const waiter = this.waiters.shift();
      if (!waiter) continue;
      try {
        waiter.resolve(JSON.parse(line));
      } catch (error) {
        waiter.reject(error);
      }
    }
  }

  next(timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (value) => {
          clearTimeout(waiter.timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(waiter.timer);
          reject(error);
        },
      };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        this.proc.kill();
        reject(new Error(`PoB2 response timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async ready() {
    const response = await this.next();
    if (!response.ok) throw new Error(response.error || "PoB2 failed to start");
    return response;
  }

  async call(action, params = {}, timeoutMs = 30000) {
    const response = this.next(timeoutMs);
    this.proc.stdin.write(`${JSON.stringify({ action, params })}\n`);
    const result = await response;
    if (!result.ok) throw new Error(`${action}: ${result.error || "failed"}`);
    return result;
  }

  async loadXml(xml, name = "API Build") {
    return this.call("load_build_xml", {
      xml,
      name,
    });
  }

  async loadBuild(buildPath, xmlScenario) {
    const xml = applyXmlScenario(
      fs.readFileSync(buildPath, "utf8"),
      xmlScenario,
    );
    return this.loadXml(
      xml,
      path.basename(buildPath, path.extname(buildPath)),
    );
  }

  async close() {
    if (!this.proc || this.proc.killed) return;
    try {
      await this.call("quit");
    } catch {
      this.proc.kill();
    }
  }
}

module.exports = {
  DEFAULT_CURRENT,
  PobClient,
  applyXmlScenario,
  readJson,
  resolveRuntime,
};
