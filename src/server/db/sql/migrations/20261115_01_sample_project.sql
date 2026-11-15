-- The sample project (Tchaikovsky 6 · Hallé) each user gets once in their
-- library, so teammates have a ready, synced baseline for manual testing
-- (services/sample-project.ts). A row means the sample was given to that user;
-- deleting the project does not bring it back.

CREATE TABLE app.sample_projects (
    user_id     INTEGER     PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    project_id  INTEGER     REFERENCES app.projects(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
