import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWebGateway } from "../web-gateway.mjs";
import { hashPassword, verifyPassword } from "../web-users.mjs";

test("web user passwords use a salted hash and verify correctly", async () => {
  const encoded = await hashPassword("paperbridge-test-password");
  assert.match(encoded, /^scrypt\$\d+\$\d+\$\d+\$/);
  assert.equal(await verifyPassword("paperbridge-test-password", encoded), true);
  assert.equal(await verifyPassword("wrong-password", encoded), false);
});

test("web gateway gives each user a private settings and projects root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-web-"));
  try {
    const gateway = createWebGateway({ dataRoot: root, usersFile: path.join(root, "users.json") });
    const roots = gateway.userRoots({ id: "../other-user", username: "alice" });
    assert.ok(roots.settings.startsWith(path.join(root, "users") + path.sep));
    assert.ok(roots.projects.startsWith(path.join(root, "users") + path.sep));
    assert.notEqual(roots.settings, gateway.userRoots({ id: "bob", username: "bob" }).settings);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("web gateway requires login and accepts a valid session", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-web-auth-"));
  const usersFile = path.join(root, "users.json");
  const passwordHash = await hashPassword("paperbridge-test-password");
  await fs.writeFile(usersFile, JSON.stringify([{ id: "alice", username: "alice@example.com", email: "alice@example.com", passwordHash }]));
  const gateway = createWebGateway({ dataRoot: root, usersFile, port: 0 });
  const running = await gateway.start();
  try {
    const unauthenticated = await fetch(`http://127.0.0.1:${running.port}/api/bootstrap`);
    assert.equal(unauthenticated.status, 401);

    const version = await fetch(`http://127.0.0.1:${running.port}/api/web/version`);
    assert.equal(version.status, 200);
    assert.deepEqual(await version.json(), { product: "web", version: "0.1.0" });

    const login = await fetch(`http://127.0.0.1:${running.port}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "alice@example.com", password: "paperbridge-test-password" })
    });
    assert.equal(login.status, 200);
    const cookies = login.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    const cookieHeader = cookies.map((value) => value.split(";", 1)[0]).join("; ");
    const session = await fetch(`http://127.0.0.1:${running.port}/api/web/session`, { headers: { Cookie: cookieHeader } });
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), { authenticated: true, username: "alice@example.com", userId: "alice" });
    const csrfFailure = await fetch(`http://127.0.0.1:${running.port}/api/config`, { method: "POST", headers: { Cookie: cookieHeader, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(csrfFailure.status, 403);
  } finally {
    await gateway.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("web gateway registers a new email only with the invite code", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-web-invite-"));
  const usersFile = path.join(root, "users.json");
  const gateway = createWebGateway({ dataRoot: root, usersFile, port: 0, inviteCode: "invite-for-test" });
  const running = await gateway.start();
  try {
    const rejected = await fetch(`http://127.0.0.1:${running.port}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "new@example.com", password: "paperbridge-test-password", inviteCode: "wrong" })
    });
    assert.equal(rejected.status, 403);
    const registered = await fetch(`http://127.0.0.1:${running.port}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "new@example.com", password: "paperbridge-test-password", inviteCode: "invite-for-test" })
    });
    assert.equal(registered.status, 200);
    const users = JSON.parse(await fs.readFile(usersFile, "utf8"));
    assert.equal(users[0].email, "new@example.com");
  } finally {
    await gateway.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});
