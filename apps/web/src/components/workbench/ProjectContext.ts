import { createContext, useContext } from "react";
import type { DesignProject } from "../../../../../packages/workbench/projects";

export const ProjectContext = createContext<{ project: DesignProject | null; loading: boolean } | null>(null);
export const useDesignProject = () => useContext(ProjectContext);
