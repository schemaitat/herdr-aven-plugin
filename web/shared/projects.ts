export interface ProjectChoice { key: string; name: string }
export interface ProjectListing {
  workspace: string;
  startup: string;
  projects: ProjectChoice[];
  status: 'ok' | 'incomplete' | 'unavailable';
  message: string;
}
