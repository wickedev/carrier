import { describe, it, expect } from "vitest";
import { makeHarness } from "./harness.js";

const json = (cookie: string) => ({
  cookie,
  "content-type": "application/json",
});

describe("marketplace registry routes", () => {
  it("publish requires a verified publisher (403 unverified_publisher)", async () => {
    const h = await makeHarness();
    const owner = await h.seedAccount("owner");
    const cookie = await h.cookieFor(owner.accountId);
    const pub = await h.seedPublisher("acme", { verified: false });
    const built = h.buildSamplePlugin({
      name: "acme/lint",
      version: "1.0.0",
      publisher: "acme",
      privateKeyPem: pub.privateKeyPem,
    });
    const res = await h.app.request("/marketplace/plugins", {
      method: "POST",
      headers: json(cookie),
      body: JSON.stringify({
        manifest: built.manifest,
        signature: built.signature,
      }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("unverified_publisher");
  });

  it("publish rejects a bad detached signature (400 bad_signature)", async () => {
    const h = await makeHarness();
    const owner = await h.seedAccount("owner");
    const cookie = await h.cookieFor(owner.accountId);
    const pub = await h.seedPublisher("acme", { verified: true });
    const built = h.buildSamplePlugin({
      name: "acme/lint",
      version: "1.0.0",
      publisher: "acme",
      privateKeyPem: pub.privateKeyPem,
    });
    const res = await h.app.request("/marketplace/plugins", {
      method: "POST",
      headers: json(cookie),
      body: JSON.stringify({
        manifest: built.manifest,
        signature: "AAAA", // not a valid signature
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_signature");
  });

  it("publish rejects a wasm digest mismatch (400 wasm_digest_mismatch)", async () => {
    const h = await makeHarness();
    const owner = await h.seedAccount("owner");
    const cookie = await h.cookieFor(owner.accountId);
    const pub = await h.seedPublisher("acme", { verified: true });
    const built = h.buildSamplePlugin({
      name: "acme/active",
      version: "1.0.0",
      publisher: "acme",
      privateKeyPem: pub.privateKeyPem,
      wasmBytes: Buffer.from("the-real-wasm-bytes"),
    });
    const res = await h.app.request("/marketplace/plugins", {
      method: "POST",
      headers: json(cookie),
      body: JSON.stringify({
        manifest: built.manifest,
        signature: built.signature,
        wasmBase64: Buffer.from("different-bytes").toString("base64"),
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("wasm_digest_mismatch");
  });

  it("publishes, then searches / lists versions / fetches a version", async () => {
    const h = await makeHarness();
    const owner = await h.seedAccount("owner");
    const cookie = await h.cookieFor(owner.accountId);
    const pub = await h.seedPublisher("acme", { verified: true });
    const wasmBytes = Buffer.from("wasm-module-bytes");
    const built = h.buildSamplePlugin({
      name: "acme/active",
      version: "1.0.0",
      publisher: "acme",
      privateKeyPem: pub.privateKeyPem,
      wasmBytes,
    });
    const pubRes = await h.app.request("/marketplace/plugins", {
      method: "POST",
      headers: json(cookie),
      body: JSON.stringify({
        manifest: built.manifest,
        signature: built.signature,
        wasmBase64: wasmBytes.toString("base64"),
      }),
    });
    expect(pubRes.status).toBe(201);
    const pubBody = await pubRes.json();
    expect(pubBody.manifestDigest).toBe(built.manifestDigest);

    // search
    const search = await h.app.request("/marketplace/plugins?q=active", {
      headers: { cookie },
    });
    expect(search.status).toBe(200);
    const listings = await search.json();
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({
      name: "acme/active",
      publisher: "acme",
      verified: true,
      latestVersion: "1.0.0",
    });

    // versions
    const versions = await h.app.request(
      "/marketplace/plugins/acme%2Factive/versions",
      { headers: { cookie } },
    );
    expect(versions.status).toBe(200);
    expect((await versions.json())[0].version).toBe("1.0.0");

    // one version → manifest + signature + wasmDigest
    const one = await h.app.request(
      "/marketplace/plugins/acme%2Factive/1.0.0",
      { headers: { cookie } },
    );
    expect(one.status).toBe(200);
    const ver = await one.json();
    expect(ver.manifestDigest).toBe(built.manifestDigest);
    expect(ver.signature).toBe(built.signature);
    expect(ver.wasmDigest).toBe(built.manifest.artifacts.wasm!.digest);
  });
});

describe("plugin install routes (org/project scope)", () => {
  it("non-manager cannot install (403)", async () => {
    const h = await makeHarness();
    const owner = await h.seedAccount("owner");
    const member = await h.seedAccount("member");
    await h.addOrgMember(owner.orgId, member.accountId, "member");
    const memberCookie = await h.cookieFor(member.accountId);
    await h.publishSamplePlugin({ name: "acme/lint", version: "1.0.0" });

    const res = await h.app.request(`/orgs/${owner.orgId}/plugins`, {
      method: "POST",
      headers: json(memberCookie),
      body: JSON.stringify({ name: "acme/lint", version: "1.0.0" }),
    });
    expect(res.status).toBe(403);
  });

  it("install of a nonexistent version is rejected (400)", async () => {
    const h = await makeHarness();
    const owner = await h.seedAccount("owner");
    const cookie = await h.cookieFor(owner.accountId);
    const res = await h.app.request(`/orgs/${owner.orgId}/plugins`, {
      method: "POST",
      headers: json(cookie),
      body: JSON.stringify({ name: "ghost/plugin", version: "9.9.9" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("version_not_found");
  });

  it("install pins the lockfile digest + lists installs", async () => {
    const h = await makeHarness();
    const owner = await h.seedAccount("owner");
    const cookie = await h.cookieFor(owner.accountId);
    const pub = await h.publishSamplePlugin({
      name: "acme/lint",
      version: "1.0.0",
    });

    const res = await h.app.request(`/orgs/${owner.orgId}/plugins`, {
      method: "POST",
      headers: json(cookie),
      body: JSON.stringify({
        name: "acme/lint",
        version: "1.0.0",
        grantedCaps: ["network:api.acme.com"],
        allowPermissions: true,
      }),
    });
    expect(res.status).toBe(201);
    const install = await res.json();
    expect(install.manifestDigest).toBe(pub.manifestDigest);
    expect(install.grantedCaps).toEqual(["network:api.acme.com"]);
    expect(install.allowPermissions).toBe(true);

    const list = await h.app.request(`/orgs/${owner.orgId}/plugins`, {
      headers: { cookie },
    });
    expect(list.status).toBe(200);
    expect((await list.json())).toHaveLength(1);
  });

  it("org allowlist blocks an unlisted plugin (403 not_allowlisted)", async () => {
    const h = await makeHarness();
    const owner = await h.seedAccount("owner");
    const cookie = await h.cookieFor(owner.accountId);
    await h.publishSamplePlugin({ name: "acme/lint", version: "1.0.0" });
    await h.publishSamplePlugin({ name: "acme/other", version: "1.0.0" });

    // Allowlist only acme/other → acme/lint is blocked.
    const { orgPluginAllowlist } = await import("../db/schema.js");
    await h.db
      .insert(orgPluginAllowlist)
      .values({ orgId: owner.orgId, pluginName: "acme/other" });

    const blocked = await h.app.request(`/orgs/${owner.orgId}/plugins`, {
      method: "POST",
      headers: json(cookie),
      body: JSON.stringify({ name: "acme/lint", version: "1.0.0" }),
    });
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).error).toBe("not_allowlisted");

    const allowed = await h.app.request(`/orgs/${owner.orgId}/plugins`, {
      method: "POST",
      headers: json(cookie),
      body: JSON.stringify({ name: "acme/other", version: "1.0.0" }),
    });
    expect(allowed.status).toBe(201);
  });

  it("patch upgrades the version and re-pins the digest", async () => {
    const h = await makeHarness();
    const owner = await h.seedAccount("owner");
    const cookie = await h.cookieFor(owner.accountId);
    const v1 = await h.publishSamplePlugin({
      name: "acme/lint",
      version: "1.0.0",
      publisher: "acme",
    });
    // Publish v2 under the SAME publisher/plugin via the route.
    const built2 = h.buildSamplePlugin({
      name: "acme/lint",
      version: "2.0.0",
      publisher: "acme",
      privateKeyPem: v1.privateKeyPem,
    });
    const pub2 = await h.app.request("/marketplace/plugins", {
      method: "POST",
      headers: json(cookie),
      body: JSON.stringify({
        manifest: built2.manifest,
        signature: built2.signature,
      }),
    });
    expect(pub2.status).toBe(201);

    const created = await h.app.request(`/orgs/${owner.orgId}/plugins`, {
      method: "POST",
      headers: json(cookie),
      body: JSON.stringify({ name: "acme/lint", version: "1.0.0" }),
    });
    const install = await created.json();

    const upgraded = await h.app.request(
      `/orgs/${owner.orgId}/plugins/${install.id}`,
      {
        method: "PATCH",
        headers: json(cookie),
        body: JSON.stringify({ version: "2.0.0" }),
      },
    );
    expect(upgraded.status).toBe(200);
    const after = await upgraded.json();
    expect(after.version).toBe("2.0.0");
    expect(after.manifestDigest).toBe(built2.manifestDigest);
    expect(after.manifestDigest).not.toBe(v1.manifestDigest);

    // disable + delete
    const disabled = await h.app.request(
      `/orgs/${owner.orgId}/plugins/${install.id}`,
      {
        method: "PATCH",
        headers: json(cookie),
        body: JSON.stringify({ enabled: false }),
      },
    );
    expect((await disabled.json()).enabled).toBe(false);

    const del = await h.app.request(
      `/orgs/${owner.orgId}/plugins/${install.id}`,
      { method: "DELETE", headers: { cookie } },
    );
    expect(del.status).toBe(200);
  });
});
