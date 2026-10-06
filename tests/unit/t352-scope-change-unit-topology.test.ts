// covers: function:unitPlanChangeRefusal, function:cachedClaimsForIdentity, subcommand:aidlc-utility:scope-change, subcommand:aidlc-utility:recompose
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  acquireAuditLock,
  activeIntentUuid,
  claimGenerationsPath,
  claimRegistryCachePath,
  writeUnitMergeTransaction,
  artifactFilename,
  findStageBySlug,
  reviewArtifactFingerprint,
  releaseAuditLock,
  setGuardPolicyLine,
  writeUnitClaimRegistryCache,
  getField,
  latestMainWorkflowStageRunFloorForProject,
  loadStageGraph,
  readAllAuditShards,
  resolveWorkflowSelection,
  setCheckbox,
  setField,
  setStageSuffix,
  unitPlanChangeRefusal,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  seedAidlcMemory,
  seedBoltDag,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
resetAidlcEnv();
const projects: string[] = [];
afterEach(() => { while (projects.length) cleanupTestProject(projects.pop()); });
const stage = "nfr-requirements";
const env = { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" };

function fixture(ownership = "team", iteration = "unit-major", dag = true): string {
  const proj = createTestProject();
  projects.push(proj);
  seedAidlcMemory(proj);
  const stages = loadStageGraph().map((node) =>
    `- [${node.slug === "functional-design" ? "-" : node.phase === "construction" || node.phase === "operation" ? " " : "x"}] ${node.slug} — EXECUTE`
  ).join("\n");
  writeFileSync(seededStateFile(proj), `# AI-DLC State Tracking

## Project Information
- **Project**: Unit plan safety
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Skeleton Stance**: on

## Runtime State
- **Revision Count**: 0
- **Construction Iteration**: ${iteration}
- **Unit Ownership**: ${ownership}
- **Unit Gate Rhythm**: per-stage

## Scope Configuration
- **Depth**: Standard
- **Test Strategy**: Standard
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Total Stages**: 33
- **Completed**: 0

## Stage Progress
<!-- Checkbox states: [ ] not started -->
${stages}

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
- **Last Updated**: 2026-09-25T00:00:00Z
`);
  if (dag) seedBoltDag(proj, ["alpha", "beta"]);
  return proj;
}
const state = (p: string) => readFileSync(seededStateFile(p), "utf8");
const putState = (p: string, content: string) => writeFileSync(seededStateFile(p), content);
const skip = (content: string, slug = stage) => setStageSuffix(content, slug, "SKIP");
function refusal(p: string, after = skip(state(p))): string | null {
  const before = state(p);
  const audit = readAllAuditShards(p);
  const result = unitPlanChangeRefusal(p, before, after, resolveWorkflowSelection(p));
  expect(state(p)).toBe(before);
  expect(readAllAuditShards(p)).toBe(audit);
  return result;
}
function lifecycle(p: string, event: "UNIT_STARTED" | "UNIT_PAUSED" | "UNIT_RESUMED" | "UNIT_COMPLETED" | "UNIT_SKIPPED", unit = "alpha", slug = stage) {
  const content = state(p);
  appendAuditEntry(event, {
    Stage: slug, Unit: unit, Reason: "fixture conditional work",
    "Run floor": latestMainWorkflowStageRunFloorForProject(p, slug,
      getField(content, "Construction Iteration") === "unit-major",
      getField(content, "Unit Ownership") === "team" ? unit : undefined),
  }, p);
}
function gate(p: string, event: "STAGE_AWAITING_APPROVAL" | "STAGE_REVISING" | "GATE_REJECTED" | "GATE_APPROVED", unit = "alpha", scope = "per-stage", slug = stage) {
  appendAuditEntry(event, { Stage: slug, Unit: unit, "Gate Scope": scope }, p);
}
function requiredArtifacts(p: string, unit: string, slug = stage): string[] {
  const node = findStageBySlug(slug)!;
  return (node.produces ?? []).map((name) => {
    const path = join(seededRecordDir(p), "construction", unit, slug, artifactFilename(name));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `# ${name} for ${unit}\n`);
    return path;
  });
}
function command(p: string, args: string[], tool = join(AIDLC_SRC, "tools", "aidlc-utility.ts")) {
  const result = spawnSync(process.execPath, [tool, ...args, "--project-dir", p], {
    encoding: "utf8", env, timeout: NATIVE_STARTUP_TIMEOUT_MS,
  });
  return { status: result.status, output: result.stdout + result.stderr };
}
function unchangedRejection(p: string, args: string[], tool?: string) {
  const before = state(p);
  const audit = readAllAuditShards(p);
  const result = command(p, args, tool);
  expect(result.status, result.output).toBe(1);
  expect(state(p)).toBe(before);
  expect(readAllAuditShards(p)).toBe(audit);
  return result.output;
}

describe("Unit plan changes use lifecycle and gate authority", () => {
  for (const ownership of ["team", "solo"]) {
    for (const iteration of ownership === "team" ? ["unit-major"] : ["unit-major", "stage-major"]) {
      for (const event of ["UNIT_STARTED", "UNIT_PAUSED", "UNIT_RESUMED"] as const) {
        test(`${ownership}/${iteration} preserves ${event} on a later Unit`, () => {
          const p = fixture(ownership, iteration);
          lifecycle(p, "UNIT_COMPLETED", "alpha");
          if (ownership === "team") gate(p, "GATE_APPROVED", "alpha");
          lifecycle(p, event, "beta");
          expect(refusal(p)).toContain('Unit "beta"');
        });
      }
    }
  }
  for (const scope of ["per-stage", "unit-end"]) {
    for (const event of ["STAGE_AWAITING_APPROVAL", "STAGE_REVISING", "GATE_REJECTED"] as const) {
      test(`${scope} ${event} is protected even when aggregate state is stale`, () => {
        const p = fixture();
        putState(p, setCheckbox(state(p), stage, "completed"));
        gate(p, event, "beta", scope);
        expect(refusal(p)).toContain('Unit "beta"');
      });
    }
  }
  test("a forged Unit Progress table cannot hide a real gate", () => {
    const p = fixture();
    putState(p, `${state(p)}\n## Unit Progress\n| unit | nfr-requirements | gate |\n| --- | --- | --- |\n| alpha | [x] | [x] |\n`);
    gate(p, "STAGE_AWAITING_APPROVAL");
    expect(refusal(p)).toContain("awaiting-approval");
  });
  test("partially completed team work cannot lose pending Units", () => {
    const p = fixture();
    requiredArtifacts(p, "alpha");
    requiredArtifacts(p, "beta");
    lifecycle(p, "UNIT_COMPLETED");
    gate(p, "GATE_APPROVED");
    expect(refusal(p)).toContain("unfinished Unit work");
    lifecycle(p, "UNIT_COMPLETED", "beta");
    gate(p, "GATE_APPROVED", "beta");
    expect(refusal(p)).toBeNull();
  });
  test("a completed body still owes its team gate despite a completed checkbox", () => {
    const p = fixture();
    lifecycle(p, "UNIT_COMPLETED");
    putState(p, setCheckbox(state(p), stage, "completed"));
    expect(refusal(p)).not.toBeNull();
  });
  test.each(["unit-major", "stage-major"])("solo %s requires every started stage's Units to settle", (iteration) => {
    const p = fixture("solo", iteration);
    requiredArtifacts(p, "alpha");
    requiredArtifacts(p, "beta");
    lifecycle(p, "UNIT_COMPLETED");
    expect(refusal(p)).not.toBeNull();
    lifecycle(p, "UNIT_COMPLETED", "beta");
    expect(refusal(p)).toBeNull();
  });
  test("solo conditionally skipped Units settle without fabricated completions", () => {
    const p = fixture("solo");
    lifecycle(p, "UNIT_SKIPPED");
    lifecycle(p, "UNIT_SKIPPED", "beta");
    expect(refusal(p)).toBeNull();
  });
  test("pending later work may leave the plan while the retained Unit stage runs", () => {
    const p = fixture();
    lifecycle(p, "UNIT_STARTED", "alpha", "functional-design");
    expect(refusal(p)).toBeNull();
  });
  test("changing an unrelated phase leaves even an open Unit gate intact", () => {
    const p = fixture();
    gate(p, "STAGE_AWAITING_APPROVAL");
    expect(refusal(p, skip(state(p), "observability-setup"))).toBeNull();
    const result = command(p, ["scope-change", "--scope", "mvp"]);
    expect(result.status, result.output).toBe(0);
    expect(state(p)).toContain("- **Scope**: mvp");
    expect(readAllAuditShards(p).match(/\*\*Event\*\*: SCOPE_CHANGED/g)).toHaveLength(1);
  });
  test("unit-end approval cannot be reused for a changed live block", () => {
    const p = fixture();
    putState(p, setField(state(p), "Unit Gate Rhythm", "unit-end"));
    gate(p, "GATE_APPROVED", "alpha", "unit-end", "code-generation");
    expect(refusal(p)).toContain("unit-end gate");
  });
  test("unit-end gate cannot move when its original endpoint remains selected", () => {
    const p = fixture();
    putState(p, skip(state(p)));
    gate(p, "STAGE_AWAITING_APPROVAL", "alpha", "unit-end", "code-generation");
    expect(refusal(p, setStageSuffix(state(p), stage, "EXECUTE"))).toContain("unit-end");
  });
  test("completed checkboxes cannot hide an open unit-end gate at a retained endpoint", () => {
    const p = fixture();
    let content = setField(state(p), "Unit Gate Rhythm", "unit-end");
    for (const node of loadStageGraph().filter((s) => s.phase === "construction")) {
      content = setCheckbox(content, node.slug, "completed");
    }
    putState(p, content);
    gate(p, "STAGE_AWAITING_APPROVAL", "alpha", "unit-end", "code-generation");
    expect(refusal(p, skip(state(p)))).toContain("unit-end gate");
  });
  test("completed checkboxes cannot reuse one Unit's approval while another Unit still owes its unit-end gate", () => {
    const p = fixture();
    let content = setField(state(p), "Unit Gate Rhythm", "unit-end");
    for (const node of loadStageGraph().filter((s) => s.phase === "construction")) {
      content = setCheckbox(content, node.slug, "completed");
    }
    putState(p, content);
    gate(p, "GATE_APPROVED", "alpha", "unit-end", "code-generation");
    expect(refusal(p, skip(state(p)))).toContain("unit-end gate");
  });
});

describe("Unit topology and historical boundaries", () => {
  test("team mode cannot keep unfinished Unit stages after removing the DAG producer", () => {
    const p = fixture();
    expect(refusal(p, skip(state(p), "units-generation"))).toContain("Keep Units Generation");
  });
  test("fully completed team Construction can leave its old topology", () => {
    const p = fixture();
    let content = state(p);
    for (const node of loadStageGraph().filter((s) => s.phase === "construction")) {
      content = setCheckbox(content, node.slug, "completed");
    }
    putState(p, setField(content, "Current Stage", "build-and-test"));
    expect(refusal(p, skip(state(p), "units-generation"))).toBeNull();
  });
  test.each(["solo", "", "team-ish"])("%s legacy ownership with no Unit activity keeps scope recovery", (ownership) => {
    const p = fixture(ownership);
    expect(refusal(p, skip(state(p), "units-generation"))).toBeNull();
  });
  test("solo in-flight Unit receipts cannot switch to stage-level artifacts", () => {
    const p = fixture("solo", "stage-major");
    lifecycle(p, "UNIT_STARTED", "alpha", "functional-design");
    expect(refusal(p, skip(state(p), "units-generation"))).toContain("unfinished work");
  });
  test("no-DAG solo scopes keep their stage-level path", () => {
    const p = fixture("solo", "stage-major", false);
    expect(refusal(p, skip(state(p), "units-generation"))).toBeNull();
  });
  test("malformed authoritative DAG fails closed instead of trusting its cache", () => {
    const p = fixture();
    mkdirSync(join(seededRecordDir(p), "inception", "units-generation"), { recursive: true });
    writeFileSync(join(seededRecordDir(p), "inception", "units-generation", "unit-of-work-dependency.md"),
      "# Units\n\n```yaml\nunits: [broken\n```\n");
    expect(refusal(p)).toContain("authoritative Unit DAG");
  });
  for (const event of ["WORKFLOW_STARTED", "STAGE_JUMPED"] as const) {
    test(`${event} ends prior lifecycle and gate authority`, () => {
      const p = fixture();
      lifecycle(p, "UNIT_PAUSED");
      gate(p, "STAGE_AWAITING_APPROVAL");
      appendAuditEntry(event, { Stage: stage, Scope: "feature", Direction: "redo" }, p);
      expect(refusal(p)).toBeNull();
    });
  }
  test("same-second cross-shard boundary does not revive an old pause or gate", () => {
    const p = fixture();
    const auditDir = seededAuditDir(p);
    mkdirSync(auditDir, { recursive: true });
    const ts = "2026-09-25T12:00:00Z";
    writeFileSync(join(auditDir, "a-work.md"),
      `## Unit\n**Event**: UNIT_PAUSED\n**Timestamp**: ${ts}\n**Stage**: ${stage}\n**Unit**: alpha\n**Run floor**: unstarted#0\n\n---\n` +
      `## Gate\n**Event**: STAGE_AWAITING_APPROVAL\n**Timestamp**: ${ts}\n**Stage**: ${stage}\n**Unit**: alpha\n\n---\n`);
    writeFileSync(join(auditDir, "z-boundary.md"),
      `## Jump\n**Event**: STAGE_JUMPED\n**Timestamp**: ${ts}\n**Stage**: functional-design\n\n---\n`);
    expect(refusal(p)).toBeNull();
  });
  test("a removed DAG Unit's open gate is still protected", () => {
    const p = fixture();
    gate(p, "STAGE_AWAITING_APPROVAL", "removed-unit");
    expect(refusal(p)).toContain("removed-unit");
  });
});

describe("mutation boundaries and harness projections", () => {
  test("scope refusal keeps bundled settings and all audit bytes unchanged", () => {
    const p = fixture();
    gate(p, "STAGE_AWAITING_APPROVAL");
    expect(unchangedRejection(p, ["scope-change", "--scope", "refactor", "--depth", "comprehensive", "--test-strategy", "minimal"]))
      .toContain("awaiting-approval");
  });
  test("recompose cannot skip a pending aggregate row with live Unit evidence", () => {
    const p = fixture();
    // NFR stages are removed as a group so dependency validation permits the
    // proposed plan; the Unit ledger, not starvation, must reject it.
    lifecycle(p, "UNIT_STARTED");
    expect(unchangedRejection(p, ["recompose", "--skip", "nfr-requirements,nfr-design,infrastructure-design"]))
      .toContain("unfinished work");
  });
  const harnesses = [
    ["claude", ".claude"], ["codex", ".codex"], ["copilot", ".aidlc"],
    ["cursor", ".cursor"], ["kiro", ".kiro"], ["kiro-ide", ".kiro"], ["opencode", ".aidlc"],
  ];
  for (const [harness, dir] of harnesses) {
    test(`${harness} rejects lost Unit topology in its generated tool`, () => {
      const p = fixture();
      gate(p, "STAGE_AWAITING_APPROVAL");
      const tool = join(import.meta.dir, "..", "..", "dist", harness, dir, "tools", "aidlc-utility.ts");
      expect(unchangedRejection(p, ["scope-change", "--scope", "refactor"], tool)).toContain("Unit");
    });
  }
});

describe("selected workflows, claims and lock boundaries", () => {
  test.each(["default", "other"])("explicit intent in space %s uses that record's ledger and claim generation", (space) => {
    const p = fixture("solo");
    const target = "target-0000000000000002";
    const targetUuid = "00000000-0000-4000-8000-000000000002";
    const targetDir = join(p, "aidlc", "spaces", space, "intents", target);
    cpSync(seededRecordDir(p), targetDir, { recursive: true });
    const registryPath = join(dirname(targetDir), "intents.json");
    const registry = existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, "utf8")) : [];
    writeFileSync(registryPath, JSON.stringify([...registry, {uuid:targetUuid, slug:"target", dirName:target, status:"in-flight"}]));
    const targetStatePath = join(targetDir, "aidlc-state.md");
    const targetState = setField(state(p), "Unit Ownership", "team");
    writeFileSync(targetStatePath, targetState);
    const fields = {Stage:stage, Unit:"alpha", "Gate Scope":"per-stage", "Attempt Generation":"1"};
    appendAuditEntry("STAGE_AWAITING_APPROVAL", fields, p, target, space);
    mkdirSync(dirname(claimGenerationsPath(p)), {recursive:true});
    writeFileSync(claimGenerationsPath(p), JSON.stringify({[`${space}/${targetUuid}/alpha`]:2}));
    const options = resolveWorkflowSelection(p, {intent:target, space});
    expect(unitPlanChangeRefusal(p, targetState, skip(targetState), options)).toBeNull();
    appendAuditEntry("STAGE_AWAITING_APPROVAL", {...fields, "Attempt Generation":"2"}, p, target, space);
    const targetAudit = readAllAuditShards(p, target, space);
    const unrelated = state(p);
    const result = command(p, ["scope-change", "--scope", "refactor", "--intent", target, "--space", space]);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("awaiting-approval");
    expect(readFileSync(targetStatePath,"utf8")).toBe(targetState);
    expect(readAllAuditShards(p,target,space)).toBe(targetAudit);
    expect(state(p)).toBe(unrelated);
    expect(readAllAuditShards(p)).toBe("");
  });

  test("claimed Units freeze topology without refreshing their cache, while unrelated scope changes remain legal", () => {
    const p = fixture();
    writeUnitClaimRegistryCache(p, {
      version:1, space:"default", intent_uuid:activeIntentUuid(p)!,
      claims:{beta:{status:"claimed", owner:"team-b", generation:2, nonce:"claim", ref:"refs/heads/claim/00000001/beta", oid:"a".repeat(40)}},
    });
    const cache = claimRegistryCachePath(p);
    const cachedBefore = readFileSync(cache, "utf8");
    expect(unchangedRejection(p, ["scope-change", "--scope", "refactor"])).toContain("claimed or merging");
    const changed = command(p, ["scope-change", "--scope", "mvp"]);
    expect(changed.status, changed.output).toBe(0);
    // The claim remains recorded; no command in the guard fetches remote refs.
    expect(readFileSync(cache, "utf8")).toBe(cachedBefore);
  });

  test("same-scope is a byte-identical no-op even with an open Unit gate", () => {
    const p = fixture();
    gate(p, "STAGE_AWAITING_APPROVAL");
    const before=state(p), audit=readAllAuditShards(p);
    expect(command(p, ["scope-change", "--scope", "feature"]).status).toBe(0);
    expect(state(p)).toBe(before);
    expect(readAllAuditShards(p)).toBe(audit);
  });

  test("scope-change reads Unit evidence only after acquiring the selected intent lock", async () => {
    const p=fixture();
    const selected=resolveWorkflowSelection(p);
    const intent=selected.intent!;
    expect(acquireAuditLock(p, 1, 1, intent, selected.space)).toBe(true);
    const child=Bun.spawn([process.execPath, join(AIDLC_SRC,"tools","aidlc-utility.ts"),
      "scope-change","--scope","refactor","--project-dir",p], {env, stdout:"pipe",stderr:"pipe"});
    const stdout=new Response(child.stdout).text(), stderr=new Response(child.stderr).text();
    try {
      await Bun.sleep(300);
      expect(child.exitCode).toBeNull();
      // Write as the concurrent lock owner, then release. The guard must
      // re-read these rows rather than act on a snapshot taken before waiting.
      const shard=join(seededAuditDir(p),"lock-owner.md");
      mkdirSync(dirname(shard),{recursive:true});
      writeFileSync(shard, `## Gate\n**Event**: STAGE_AWAITING_APPROVAL\n**Timestamp**: 2026-09-25T12:00:00Z\n**Stage**: ${stage}\n**Unit**: beta\n**Gate Scope**: per-stage\n\n---\n`);
    } finally {
      releaseAuditLock(p,intent,selected.space);
    }
    const before=state(p), audit=readAllAuditShards(p);
    expect(await child.exited).toBe(1);
    expect(await stdout).toBe("");
    expect(JSON.parse(await stderr).error).toContain('Unit "beta"');
    expect(state(p)).toBe(before);
    expect(readAllAuditShards(p)).toBe(audit);
    expect(acquireAuditLock(p,1,1,intent,selected.space)).toBe(true);
    releaseAuditLock(p,intent,selected.space);
  });

  test("recompose locks an explicitly selected intent before reading its Unit gates", async () => {
    const p = fixture();
    const space = "other";
    const target = "target-0000000000000002";
    const targetUuid = "00000000-0000-4000-8000-000000000002";
    const targetDir = join(p, "aidlc", "spaces", space, "intents", target);
    cpSync(seededRecordDir(p), targetDir, { recursive: true });
    writeFileSync(join(dirname(targetDir), "intents.json"), JSON.stringify([
      { uuid: targetUuid, slug: "target", dirName: target, status: "in-flight" },
    ]));
    const targetState = join(targetDir, "aidlc-state.md");
    expect(acquireAuditLock(p, 1, 1, target, space)).toBe(true);
    const child = Bun.spawn([process.execPath, join(AIDLC_SRC, "tools", "aidlc-utility.ts"),
      "recompose", "--skip", "nfr-requirements,nfr-design,infrastructure-design",
      "--intent", target, "--space", space, "--project-dir", p,
    ], { env, stdout: "pipe", stderr: "pipe" });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    try {
      await Bun.sleep(300);
      expect(child.exitCode).toBeNull();
      const shard = join(targetDir, "audit", "lock-owner.md");
      mkdirSync(dirname(shard), { recursive: true });
      writeFileSync(shard, `## Gate\n**Event**: STAGE_AWAITING_APPROVAL\n**Timestamp**: 2026-09-25T12:00:00Z\n**Stage**: ${stage}\n**Unit**: beta\n**Gate Scope**: per-stage\n\n---\n`);
    } finally {
      releaseAuditLock(p, target, space);
    }
    const before = readFileSync(targetState, "utf8");
    const audit = readAllAuditShards(p, target, space);
    const defaultState = state(p);
    expect(await child.exited).toBe(1);
    expect(await stdout).toBe("");
    expect(JSON.parse(await stderr).error).toContain('Unit "beta"');
    expect(readFileSync(targetState, "utf8")).toBe(before);
    expect(readAllAuditShards(p, target, space)).toBe(audit);
    expect(state(p)).toBe(defaultState);
    expect(acquireAuditLock(p, 1, 1, target, space)).toBe(true);
    releaseAuditLock(p, target, space);
  });
});

describe("wave receipts and remaining compatibility", () => {
  test("stale wave completions remain unfinished, and fresh ones can leave the plan", () => {
    const p=fixture("solo","stage-major");
    const node=findStageBySlug(stage)!;
    for(const unit of ["alpha","beta"]) {
      const dir=join(seededRecordDir(p),"construction",unit,stage);
      mkdirSync(dir,{recursive:true});
      for(const name of [...node.produces??[],...node.optional_produces??[]]) {
        writeFileSync(join(dir,artifactFilename(name)),`# ${name} ${unit}\n`);
      }
      appendAuditEntry("UNIT_COMPLETED",{
        Stage:stage,Unit:unit,Mode:"wave","Run floor":latestMainWorkflowStageRunFloorForProject(p,stage),
        "Artifact Fingerprint":reviewArtifactFingerprint(p,node,unit,{requireRequiredArtifacts:true})!,
      },p);
    }
    expect(refusal(p)).toBeNull();
    writeFileSync(join(seededRecordDir(p),"construction","alpha",stage,artifactFilename(node.produces![0])),"Changed\n");
    expect(refusal(p)).toContain('Unit "alpha"');
    for (const policy of ["relaxed", "off"] as const) {
      putState(p, setGuardPolicyLine(state(p), `${policy} (person)`));
      expect(refusal(p)).toBeNull();
    }
  });
  test("solo no-DAG revision keeps the established skip recovery", () => {
    const p=fixture("solo","unit-major",false);
    putState(p,setCheckbox(state(p),"functional-design","revising"));
    const changed=command(p,["scope-change","--scope","bugfix"]);
    expect(changed.status,changed.output).toBe(0);
    expect(state(p)).toContain("- [R] functional-design — SKIP");
  });
  test("scope-change refuses an unreadable audit shard without partially applying settings", () => {
    const p=fixture();
    mkdirSync(join(seededAuditDir(p),"unreadable.md"),{recursive:true});
    const result=unchangedRejection(p,["scope-change","--scope","refactor","--depth","comprehensive"]);
    expect(result).toContain("unreadable");
  });
  test("topology changes refuse terminated audit events missing a timestamp", () => {
    const p = fixture();
    const shard = join(seededAuditDir(p), "damaged.md");
    mkdirSync(dirname(shard), { recursive: true });
    writeFileSync(shard, `## Unit Started\n**Event**: UNIT_STARTED\n**Stage**: ${stage}\n**Unit**: alpha\n**Run floor**: unstarted#0\n\n---\n`);
    expect(refusal(p)).toContain("malformed");
    expect(unchangedRejection(p, ["scope-change", "--scope", "refactor"]))
      .toContain("malformed");
  });
  test("topology changes refuse terminated Unit events missing an Event field", () => {
    const p = fixture();
    const shard = join(seededAuditDir(p), "damaged.md");
    mkdirSync(dirname(shard), { recursive: true });
    writeFileSync(shard, `## Unit Started\n**Timestamp**: 2026-09-25T12:00:00Z\n**Stage**: ${stage}\n**Unit**: alpha\n**Run floor**: unstarted#0\n\n---\n`);
    expect(refusal(p)).toContain("malformed");
  });
  test("audit notes and unfinished append tails remain non-event data", () => {
    const p = fixture();
    const shard = join(seededAuditDir(p), "notes.md");
    mkdirSync(dirname(shard), { recursive: true });
    writeFileSync(shard, "## Note\n**Timestamp**: 2026-09-25T12:00:00Z\nA human note.\n\n---\n" +
      `## Unit Started\n**Event**: UNIT_STARTED\n**Stage**: ${stage}\n**Unit**: alpha\n`);
    expect(refusal(p)).toBeNull();
  });
});

describe("completed approvals and merge recovery", () => {
  test("completed aggregate cannot conceal partial approvals", () => {
    const p=fixture();
    requiredArtifacts(p, "alpha");
    requiredArtifacts(p, "beta");
    putState(p,setCheckbox(state(p),stage,"completed"));
    gate(p,"GATE_APPROVED","alpha");
    expect(refusal(p)).toContain("unfinished Unit work");
    gate(p,"GATE_APPROVED","beta");
    expect(refusal(p)).toBeNull();
  });
  test("fully completed and approved unit-end work remains historical", () => {
    const p=fixture();
    requiredArtifacts(p, "alpha");
    requiredArtifacts(p, "beta");
    let content=setField(state(p),"Unit Gate Rhythm","unit-end");
    for (const node of loadStageGraph().filter(s=>s.phase==="construction")) {
      content=setCheckbox(content,node.slug,"completed");
    }
    putState(p,content);
    for(const unit of ["alpha","beta"]) {
      lifecycle(p,"UNIT_COMPLETED",unit);
      gate(p,"GATE_APPROVED",unit,"unit-end","code-generation");
    }
    expect(refusal(p)).toBeNull();
  });
  test("unfinished merge journals protect Unit topology even after claims were released", () => {
    const p=fixture();
    const uuid=activeIntentUuid(p)!;
    const transaction={
      version:1 as const,status:"git-landed" as const,space:"default",intent_uuid:uuid,intent_id8:"00000001",
      unit:"beta",owner:"team-b",generation:1,nonce:"merge",claim_ref:"refs/heads/claim/00000001/beta",
      pinned_oid:"a".repeat(40),candidate_tree_oid:"b".repeat(40),candidate_base_oid:"c".repeat(40),
      integration_oid:"d".repeat(40),integration_branch:"main",main_before_oid:"e".repeat(40),pinned_at:"2026-09-25T00:00:00Z",
      evidence:{stages_expected:[],stages_completed:[],gates_expected:[],gates_approved:[],reviewers_expected:[],
        reviewers_ready:[],plan_fingerprint:null,artifact_paths:[],audit_shards:[],outside_unit_record_paths:[],merge_held:false},
    };
    writeUnitMergeTransaction(p,transaction);
    expect(unchangedRejection(p,["scope-change","--scope","refactor"])).toContain("claimed or merging");
    writeUnitMergeTransaction(p,{...transaction,status:"complete"});
    expect(unchangedRejection(p,["scope-change","--scope","refactor"])).not.toContain("claimed or merging");
  });
  test("recompose rejection does not write audit for an already-running aggregate stage", () => {
    const p=fixture();
    putState(p,setCheckbox(state(p),stage,"in-progress"));
    expect(unchangedRejection(p,["recompose","--skip",stage])).toContain("not pending");
  });
});

describe("routing compatibility beyond explicit completion receipts", () => {
  test.each(["per-stage", "unit-end"])("team conditional skips still owe their %s approval", (rhythm) => {
    const p = fixture();
    putState(p, setField(state(p), "Unit Gate Rhythm", rhythm));
    for (const unit of ["alpha", "beta"]) lifecycle(p, "UNIT_SKIPPED", unit);
    expect(refusal(p)).not.toBeNull();
    for (const unit of ["alpha", "beta"]) {
      gate(p, "GATE_APPROVED", unit, rhythm, rhythm === "unit-end" ? "code-generation" : stage);
    }
    expect(refusal(p)).toBeNull();
  });

  test.each(["team", "solo"])("%s legacy artifact work is protected before lifecycle adoption", (ownership) => {
    const p = fixture(ownership);
    const artifact = join(seededRecordDir(p), "construction", "alpha", stage,
      artifactFilename(findStageBySlug(stage)!.produces![0]));
    mkdirSync(dirname(artifact), { recursive: true });
    writeFileSync(artifact, "# Partially written Unit work\n");
    expect(refusal(p)).toContain("unfinished Unit work");
  });

  test("all Unit approvals settle a stale aggregate without requiring a projection write", () => {
    const p = fixture();
    requiredArtifacts(p, "alpha");
    requiredArtifacts(p, "beta");
    putState(p, setCheckbox(state(p), stage, "in-progress"));
    for (const unit of ["alpha", "beta"]) {
      lifecycle(p, "UNIT_COMPLETED", unit);
      gate(p, "GATE_APPROVED", unit);
    }
    expect(refusal(p)).toBeNull();
  });

  test("a scope cannot introduce DAG routing into running stage-level Construction", () => {
    const p = fixture("solo", "stage-major", false);
    putState(p, skip(state(p), "units-generation"));
    expect(refusal(p, setStageSuffix(state(p), "units-generation", "EXECUTE"))).not.toBeNull();
    expect(unchangedRejection(p, ["scope-change", "--scope", "mvp"])).toContain("Unit DAG");
  });

  test("stage-level work cannot be orphaned when a stale DAG is re-enabled", () => {
    const p = fixture("solo", "stage-major");
    putState(p, skip(setCheckbox(state(p), "functional-design", "completed"), "units-generation"));
    const path = join(seededRecordDir(p), "construction", stage,
      artifactFilename(findStageBySlug(stage)!.produces![0]));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "# In-progress stage-level work\n");
    expect(refusal(p, setStageSuffix(state(p), "units-generation", "EXECUTE")))
      .toContain("stage-level artifacts");
    putState(p, setCheckbox(state(p), stage, "completed"));
    expect(refusal(p, setStageSuffix(state(p), "units-generation", "EXECUTE")))
      .toContain("stage-level artifacts");
  });

  test("approved Unit gates do not hide deleted required artifacts", () => {
    const p = fixture();
    const [artifact] = requiredArtifacts(p, "alpha");
    requiredArtifacts(p, "beta");
    for (const unit of ["alpha", "beta"]) {
      lifecycle(p, "UNIT_COMPLETED", unit);
      gate(p, "GATE_APPROVED", unit);
    }
    expect(refusal(p)).toBeNull();
    unlinkSync(artifact);
    expect(refusal(p)).toContain("required artifacts");
  });

  test("a pending per-stage addition retains the held Unit gate", () => {
    const p = fixture();
    putState(p, skip(state(p), "infrastructure-design"));
    gate(p, "STAGE_AWAITING_APPROVAL");
    const result = command(p, ["recompose", "--add", "infrastructure-design"]);
    expect(result.status, result.output).toBe(0);
    expect(state(p)).toContain("- [ ] infrastructure-design — EXECUTE");
    expect(readAllAuditShards(p)).toContain("STAGE_AWAITING_APPROVAL");
    expect(readAllAuditShards(p).match(/\*\*Event\*\*: RECOMPOSED/g)).toHaveLength(1);
  });

  test("invalid scope settings refuse before writing diagnostic audit", () => {
    const p = fixture();
    expect(unchangedRejection(p, ["scope-change", "--scope", "refactor", "--depth"])).toContain("nonblank value");
    expect(unchangedRejection(p, ["scope-change", "--scope", "refactor", "--unknown", "value"])).toContain("does not accept");
  });
});
