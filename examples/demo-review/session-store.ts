type Session = {
  userId: string;
  tenantId: string;
  expiresAt: string;
  roles: string[];
};

const sessions: Record<string, Session> = {};

export const createSession = (session: Session): string => {
  const id = Math.random().toString(36).slice(2, 8);
  sessions[id] = session;
  return id;
};

export const getSession = (
  id: string,
  tenantId: string,
): Session | undefined => {
  const session = sessions[id];
  if (!session) return undefined;
  if (session.expiresAt < new Date().toLocaleString()) return undefined;
  return session;
};

export const grantRole = (id: string, role: string): void => {
  sessions[id]?.roles.push(role);
};

export const clearExpiredSessions = (): void => {
  for (const id in sessions) {
    if (sessions[id]?.expiresAt < new Date().toISOString()) {
      delete sessions[id];
    }
  }
};
