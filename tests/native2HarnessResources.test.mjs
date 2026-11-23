import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { backendEnvFor, createBackendFixture } from "./helpers/native2BackendHarness.mjs";

/** Keep debug-backend fixtures independent of the installed application's environment. */
function fixtureFor(t) {
	const fixture = createBackendFixture({ prefix: "pideck-native2-resources-" });
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
	return fixture;
}

test("backend fixtures explicitly use the checkout's bundled resources by default", (t) => {
	const fixture = fixtureFor(t);
	const env = backendEnvFor(fixture);
	assert.equal(env.PIDECK_RESOURCES_PATH, fileURLToPath(new URL("../resources", import.meta.url)));
	assert.equal(env.PIDECK_USER_DATA, fixture.userData);
});

test("backend fixtures use the supplied application root's resources", (t) => {
	const fixture = fixtureFor(t);
	const appPath = join(fixture.root, "custom-app");
	const env = backendEnvFor(fixture, { PIDECK_APP_PATH: appPath });
	assert.equal(env.PIDECK_RESOURCES_PATH, join(appPath, "resources"));
});

test("backend fixtures keep the agent and host homes inside their temporary root", (t) => {
	const fixture = fixtureFor(t);
	const env = backendEnvFor(fixture);
	assert.equal(env.PIDECK_HOME, join(fixture.root, "home"));
	assert.equal(env.PIDECK_HOST_HOME, join(fixture.root, "home"));
});

test("a supplied fixture home also becomes the default host home", (t) => {
	const fixture = fixtureFor(t);
	const home = join(fixture.root, "custom-home");
	const env = backendEnvFor(fixture, { PIDECK_HOME: home });
	assert.equal(env.PIDECK_HOME, home);
	assert.equal(env.PIDECK_HOST_HOME, home);
});

test("a fixture can deliberately use separate agent and host homes", (t) => {
	const fixture = fixtureFor(t);
	const agentHome = join(fixture.root, "agent-home");
	const hostHome = join(fixture.root, "host-home");
	const env = backendEnvFor(fixture, { PIDECK_HOME: agentHome, PIDECK_HOST_HOME: hostHome });
	assert.equal(env.PIDECK_HOME, agentHome);
	assert.equal(env.PIDECK_HOST_HOME, hostHome);
});

test("an explicit fixture resources directory overrides both defaults", (t) => {
	const fixture = fixtureFor(t);
	const resources = join(fixture.root, "custom-resources");
	const env = backendEnvFor(fixture, {
		PIDECK_APP_PATH: join(fixture.root, "custom-app"),
		PIDECK_RESOURCES_PATH: resources,
	});
	assert.equal(env.PIDECK_RESOURCES_PATH, resources);
});
