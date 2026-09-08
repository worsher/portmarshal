import type { Flags } from "../flags.js";
import { collectDoctor, formatDoctor, type DoctorReport } from "../doctor.js";
import { EXIT } from "../types.js";

export default async function doctor(flags: Flags): Promise<number> {
  let report: DoctorReport;
  try { report = await collectDoctor({ project: flags.project }); }
  catch {
    report = {
      schemaVersion: 1, version: "unknown", project: null, status: "error", complete: false,
      owner: { source: "none", available: false },
      checks: [{ id: "doctor.collection", status: "error", summary: "Diagnostic collection failed.",
        details: [], nextSteps: ["Retry doctor in the intended project environment."] }],
    };
  }
  process.stdout.write(flags.json ? JSON.stringify(report, null, 2) + "\n" : formatDoctor(report));
  return report.status === "error" ? EXIT.ERR : EXIT.OK;
}
