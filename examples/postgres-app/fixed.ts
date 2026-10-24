import { buildApplication } from './app.ts';
export const createApplication = (context: { databaseUrl: string }) => buildApplication(context, true);
