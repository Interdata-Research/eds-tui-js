import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRepoUrl, DEFAULT_REPO_URL } from "./upgrade.js";

test("resolveRepoUrl: no argument means this project's GitHub repo", () => {
  assert.equal(resolveRepoUrl(undefined), DEFAULT_REPO_URL);
  assert.equal(resolveRepoUrl("  "), DEFAULT_REPO_URL);
});

test("resolveRepoUrl: owner/repo shorthand expands to a GitHub clone URL", () => {
  assert.equal(resolveRepoUrl("someone/eds-tui-js"), "https://github.com/someone/eds-tui-js.git");
  assert.equal(resolveRepoUrl("someone/eds-tui-js.git"), "https://github.com/someone/eds-tui-js.git");
});

test("resolveRepoUrl: full URLs and local paths are passed through unchanged", () => {
  assert.equal(resolveRepoUrl("https://github.com/x/y"), "https://github.com/x/y");
  assert.equal(resolveRepoUrl("git@github.com:x/y.git"), "git@github.com:x/y.git");
  assert.equal(resolveRepoUrl("/home/me/eds-tui-js"), "/home/me/eds-tui-js");
  assert.equal(resolveRepoUrl("./eds-tui-js"), "./eds-tui-js");
  assert.equal(resolveRepoUrl("../x"), "../x");
});
