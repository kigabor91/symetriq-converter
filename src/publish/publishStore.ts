import * as fs from "node:fs";
import * as path from "node:path";
import { getDataDirectory } from "../projectStore.js";
import type { PublishJob } from "./publishModels.js";

const defaultPublishesDirectory = path.join(getDataDirectory(), "publishes");

export class PublishStorage {
    constructor(private readonly publishesDirectory = defaultPublishesDirectory) {}

    readJobs(): PublishJob[] {
        fs.mkdirSync(this.publishesDirectory, { recursive: true });
        const jobsFile = path.join(this.publishesDirectory, "publishes.json");
        if (!fs.existsSync(jobsFile)) return [];
        return JSON.parse(fs.readFileSync(jobsFile, "utf8")) as PublishJob[];
    }

    createJob(job: PublishJob): void {
        const jobs = this.readJobs();
        jobs.push(job);
        this.writeJobs(jobs);
    }

    updateJob(publishId: string, update: (job: PublishJob) => void): PublishJob | undefined {
        const jobs = this.readJobs();
        const job = jobs.find((candidate) => candidate.id === publishId);
        if (!job) return undefined;
        update(job);
        this.writeJobs(jobs);
        return job;
    }

    getJob(publishId: string): PublishJob | undefined {
        return this.readJobs().find((candidate) => candidate.id === publishId);
    }

    removeJob(publishId: string): void {
        this.writeJobs(this.readJobs().filter((candidate) => candidate.id !== publishId));
    }

    private writeJobs(jobs: PublishJob[]): void {
        fs.mkdirSync(this.publishesDirectory, { recursive: true });
        const jobsFile = path.join(this.publishesDirectory, "publishes.json");
        const temporaryPath = `${jobsFile}.tmp`;
        fs.writeFileSync(temporaryPath, JSON.stringify(jobs, null, 2));
        fs.renameSync(temporaryPath, jobsFile);
    }
}
