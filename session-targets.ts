export interface TargetIdentity {
  id: string;
  name?: string;
}

export const MIN_SESSION_TARGET_PREFIX_LENGTH = 8;

export interface TargetResolution<T extends TargetIdentity> {
  status: "none" | "found" | "ambiguous" | "prefix_too_short";
  target?: T;
  matches: T[];
  minLength?: number;
}

export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, MIN_SESSION_TARGET_PREFIX_LENGTH);
}

function normalizedNames(sessions: TargetIdentity[]): Set<string> {
  return new Set(sessions
    .map((session) => session.name?.trim().toLowerCase())
    .filter((name): name is string => Boolean(name)));
}

export function formatSessionTarget(session: TargetIdentity, allSessions: TargetIdentity[] = [session]): string {
  const ids = allSessions.map((candidate) => candidate.id.toLowerCase());
  const names = normalizedNames(allSessions);
  const id = session.id.toLowerCase();

  for (let length = MIN_SESSION_TARGET_PREFIX_LENGTH; length < session.id.length; length += 1) {
    const prefix = id.slice(0, length);
    const uniqueIdPrefix = ids.filter((candidateId) => candidateId.startsWith(prefix)).length === 1;
    if (uniqueIdPrefix && !names.has(prefix)) {
      return session.id.slice(0, length);
    }
  }

  return session.id;
}

export function formatTargetOptions(sessions: TargetIdentity[], allSessions: TargetIdentity[] = sessions): string {
  return sessions
    .map((session) => `${session.name || shortSessionId(session.id)} → ${formatSessionTarget(session, allSessions)}`)
    .join(", ");
}

export function targetDisplayName(session: TargetIdentity, allSessions: TargetIdentity[] = [session]): string {
  if (!session.name?.trim()) {
    return session.id;
  }

  const lowerName = session.name.trim().toLowerCase();
  const duplicateName = allSessions.some((candidate) =>
    candidate.id !== session.id && candidate.name?.trim().toLowerCase() === lowerName
  );
  const nameConflictsWithOtherIdPrefix = allSessions.some((candidate) =>
    candidate.id !== session.id && candidate.id.toLowerCase().startsWith(lowerName)
  );

  return duplicateName || nameConflictsWithOtherIdPrefix
    ? `${session.name} (${formatSessionTarget(session, allSessions)})`
    : session.name;
}

export function resolveSessionTarget<T extends TargetIdentity>(sessions: T[], rawTarget: string): TargetResolution<T> {
  const target = rawTarget.trim();
  const lowerTarget = target.toLowerCase();

  const exactIdMatches = sessions.filter((session) => session.id.toLowerCase() === lowerTarget);
  if (exactIdMatches.length === 1) {
    return { status: "found", target: exactIdMatches[0], matches: exactIdMatches };
  }
  if (exactIdMatches.length > 1) {
    return { status: "ambiguous", matches: exactIdMatches };
  }

  const nameMatches = sessions.filter((session) => session.name?.trim().toLowerCase() === lowerTarget);
  const allPrefixMatches = sessions.filter((session) => session.id.toLowerCase().startsWith(lowerTarget));
  const prefixMatches = target.length >= MIN_SESSION_TARGET_PREFIX_LENGTH ? allPrefixMatches : [];
  if (target.length > 0 && target.length < MIN_SESSION_TARGET_PREFIX_LENGTH && allPrefixMatches.length > 0) {
    if (nameMatches.length > 0) {
      const matchesById = new Map<string, T>();
      for (const session of [...nameMatches, ...allPrefixMatches]) {
        matchesById.set(session.id, session);
      }
      const matches = Array.from(matchesById.values());
      if (matches.length === 1) {
        return { status: "found", target: matches[0], matches };
      }
      return { status: "ambiguous", matches };
    }
    return { status: "prefix_too_short", matches: allPrefixMatches, minLength: MIN_SESSION_TARGET_PREFIX_LENGTH };
  }

  const matchesById = new Map<string, T>();
  for (const session of [...nameMatches, ...prefixMatches]) {
    matchesById.set(session.id, session);
  }
  const matches = Array.from(matchesById.values());

  if (matches.length === 1) {
    return { status: "found", target: matches[0], matches };
  }
  if (matches.length > 1) {
    return { status: "ambiguous", matches };
  }
  return { status: "none", matches: [] };
}
