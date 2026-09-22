import express from "express";
import { UploadSessionError, type UploadSessionService } from "./uploadSessionService.js";
import { toUploadSessionResponse } from "./uploadSessionTypes.js";

function sendError(response: express.Response, error: unknown): void {
    if (error instanceof UploadSessionError) {
        response.status(error.statusCode).json({
            error: {
                code: error.code,
                message: error.message,
                retryable: error.retryable,
            },
        });
        return;
    }
    console.error("Upload session request failed", error);
    response.status(500).json({
        error: {
            code: "UPLOAD_SESSION_FAILURE",
            message: "The upload session request failed.",
            retryable: true,
        },
    });
}

export function createUploadSessionRouter(service: UploadSessionService): express.Router {
    const router = express.Router();

    router.post("/api/projects/:projectId/uploads", (request, response) => {
        try {
            const result = service.createSession({
                projectId: request.params.projectId,
                filename: request.body?.filename,
                mimeType: request.body?.mimeType,
                fileKind: request.body?.fileKind,
                totalBytes: request.body?.totalBytes,
                expectedSha256: request.body?.expectedSha256,
                idempotencyKey: request.header("Idempotency-Key"),
            });
            response.setHeader("Location", `/api/uploads/${result.session.uploadId}`);
            response.status(result.created ? 201 : 200).json(toUploadSessionResponse(result.session));
        } catch (error) {
            sendError(response, error);
        }
    });

    router.get("/api/uploads/:uploadId", (request, response) => {
        try {
            response.json(toUploadSessionResponse(service.getSessionStatus(String(request.params.uploadId ?? ""))));
        } catch (error) {
            sendError(response, error);
        }
    });

    router.post("/api/uploads/:uploadId/complete", async (request, response) => {
        try {
            const result = await service.completeSession(String(request.params.uploadId ?? ""));
            response.status(result.alreadyComplete ? 200 : 202).json(toUploadSessionResponse(result.session));
        } catch (error) {
            sendError(response, error);
        }
    });

    router.put("/api/uploads/:uploadId/parts/:partNumber", async (request, response) => {
        try {
            const result = await service.uploadPart({
                uploadId: request.params.uploadId,
                partNumber: request.params.partNumber,
                contentLength: request.headers["content-length"],
                contentType: request.headers["content-type"],
                expectedSha256: request.headers["x-part-sha256"],
                body: request,
            });
            response.status(result.alreadyPresent ? 200 : 201).json(result);
        } catch (error) {
            sendError(response, error);
        }
    });

    router.delete("/api/uploads/:uploadId", async (request, response) => {
        try {
            response.json(toUploadSessionResponse(await service.cancelSession(String(request.params.uploadId ?? ""))));
        } catch (error) {
            sendError(response, error);
        }
    });

    return router;
}
