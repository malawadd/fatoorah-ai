import type { DestinationPlatform, DestinationState, IntakeJob, JobStatus, ValidationResult } from "../shared/invoice";
import { destinationLabel, normalizeDestinationPlatforms, upsertDestinationState } from "../shared/invoice";

export function defaultDestinationPlatforms(): DestinationPlatform[] {
  return normalizeDestinationPlatforms(
    process.env.INVOICE_DESTINATIONS ?? process.env.DESTINATION_PLATFORMS,
    ["qoyod"]
  );
}

export function destinationPlatformsFromBody(body: unknown): DestinationPlatform[] {
  const payload = body && typeof body === "object" ? body as Record<string, unknown> : {};
  return normalizeDestinationPlatforms(payload.destinations ?? payload.destinationPlatforms, defaultDestinationPlatforms());
}

export function destinationReadyStates(
  platforms: DestinationPlatform[],
  now = new Date().toISOString()
): DestinationState[] {
  return platforms.map((platform) => ({
    platform,
    status: "ready",
    requestedAt: now,
    updatedAt: now
  }));
}

export function mergeDestinationStates(
  current: DestinationState[] | undefined,
  nextStates: DestinationState[]
): DestinationState[] {
  return nextStates.reduce((destinations, state) => upsertDestinationState(destinations, state), current ?? []);
}

export function releasedJobStatus(validation: ValidationResult, platforms: DestinationPlatform[]): JobStatus {
  if (!validation.canSubmitToRobot) return "needs_review";
  return platforms.includes("qoyod") ? "ready_for_qoyod" : "reviewed";
}

export function readyDestinationMessage(platforms: DestinationPlatform[]): string {
  return `Review complete. Destinations ready: ${platforms.map(destinationLabel).join(", ")}.`;
}

export function hasActiveQoyodDestination(job: IntakeJob): boolean {
  return Boolean(job.destinations?.some((destination) =>
    destination.platform === "qoyod" &&
    ["ready", "posting"].includes(destination.status)
  ));
}

export function statusAfterDestinationPosting(
  job: IntakeJob,
  platform: DestinationPlatform,
  outcome: "started" | "success" | "error"
): JobStatus {
  if (platform === "qoyod") {
    return job.status;
  }

  if (hasActiveQoyodDestination(job)) {
    return job.status === "qoyod_filling" ? "qoyod_filling" : "ready_for_qoyod";
  }

  if (outcome === "started") return "posting";
  if (outcome === "success") return "posted";
  return "posting_error";
}
