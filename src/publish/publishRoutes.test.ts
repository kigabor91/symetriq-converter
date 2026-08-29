import assert from "node:assert/strict";
import test from "node:test";
import { toPublishableProjects } from "./publishRoutes.js";

test("publishable projects keep only the stable id and name fields", () => {
    const projects = toPublishableProjects([
        { id: "office-building", name: "Office Building" },
        { id: "hospital", name: "Hospital" },
    ]);

    assert.deepEqual(projects, [
        { id: "office-building", name: "Office Building" },
        { id: "hospital", name: "Hospital" },
    ]);
});
