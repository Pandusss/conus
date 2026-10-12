import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

let container: StartedPostgreSqlContainer | undefined;

export default async function setup(project: TestProject) {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    // Debian image on purpose: en_US.utf8 ctype is needed for pg_trgm on Cyrillic.
    container = await new PostgreSqlContainer('postgres:16').start();
    url = container.getConnectionUri();
  }
  project.provide('pgAdminUrl', url);
  return async () => {
    await container?.stop();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}
