import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { maskBytes, maskFiles, secretForms, secretMask } from "../worker/mask.ts";

describe("secretMask", () => {
  it("hides a value, its encodings, and the password inside a URL", () => {
    const url = "postgres://reader:p%40ss-w0rd-long@db:5432/app";
    const mask = secretMask({ DB_URL: url }, ["DB_URL"]);
    expect(mask(`connect ${url} failed`)).toBe("connect [DB_URL hidden] failed");
    expect(mask(`encoded ${encodeURIComponent(url)}`)).toBe("encoded [DB_URL hidden]");
    expect(mask(`b64 ${Buffer.from(url).toString("base64")}`)).toBe("b64 [DB_URL hidden]");
    expect(mask("password p@ss-w0rd-long")).toBe("password [DB_URL hidden]");
    expect(mask("password p%40ss-w0rd-long")).toBe("password [DB_URL hidden]");
    expect([...mask.hidden]).toEqual(["DB_URL"]);
  });

  it("hides a token printed alone from inside a base64 kubeconfig", () => {
    const token = "eyJhbGciOiJSUzI1NiIsImtpZCI6IjEyMyJ9";
    const kubeconfig = Buffer.from(`users:\n- name: admin\n  user:\n    token: ${token}\n`).toString(
      "base64",
    );
    const mask = secretMask({ KUBECONFIG_BASE64: kubeconfig }, ["KUBECONFIG_BASE64"]);
    expect(mask(`Authorization: Bearer ${token}`)).toBe("Authorization: Bearer [KUBECONFIG_BASE64 hidden]");
    expect(mask("name: admin")).toBe("name: admin");
  });

  it("leaves short and unset values, and text without secrets, alone", () => {
    const mask = secretMask({ SHORT: "abc123", EMPTY: "" }, ["SHORT", "EMPTY", "MISSING"]);
    expect(mask("abc123 and more")).toBe("abc123 and more");
    expect(mask.hidden.size).toBe(0);
  });

  it("finds without hiding", () => {
    const mask = secretMask({ A_KEY: "sk_live_0123456789", B_KEY: "another-long-value" }, ["A_KEY", "B_KEY"]);
    expect(mask.find("x sk_live_0123456789 y another-long-value")).toEqual(["A_KEY", "B_KEY"]);
    expect(mask.hidden.size).toBe(0);
  });

  it("covers a value's forms, longest first in effect", () => {
    expect(secretForms("sk_live_0123456789")).toContain(Buffer.from("sk_live_0123456789").toString("base64"));
  });
});

describe("masking files", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "kiln-mask-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("rewrites text files in folders, leaves binary files and missing paths alone", async () => {
    const value = "sk_live_0123456789";
    const mask = secretMask({ KEY: value }, ["KEY"]);
    await mkdir(join(root, "a", "b"), { recursive: true });
    await writeFile(join(root, "a", "b", "log.jsonl"), `{"key":"${value}"}`);
    const binary = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00]), Buffer.from(value)]);
    await writeFile(join(root, "a", "db.sqlite"), binary);
    await maskFiles(mask, [join(root, "a"), join(root, "missing")]);
    expect(await readFile(join(root, "a", "b", "log.jsonl"), "utf8")).toBe('{"key":"[KEY hidden]"}');
    expect(await readFile(join(root, "a", "db.sqlite"))).toEqual(binary);
  });

  it("hides secrets in text bytes only", () => {
    const mask = secretMask({ KEY: "sk_live_0123456789" }, ["KEY"]);
    expect(Buffer.from(maskBytes(mask, new Uint8Array(Buffer.from("k=sk_live_0123456789")))).toString()).toBe(
      "k=[KEY hidden]",
    );
  });
});
