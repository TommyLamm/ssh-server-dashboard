# Port 6666 Change Design Spec

**Date:** 2026-05-28  
**Status:** Approved  
**Author:** GitHub Copilot  

## Goal
Switch the dashboard service to listen on port 6666 inside the container and expose port 6666 on the host because port 3000 is already in use.

## Scope
- Update Docker Compose port mapping to `6666:6666`.
- Set `PORT=6666` in Docker Compose environment.
- Update Dockerfile `EXPOSE` to `6666` for consistency.

## Out of Scope
- Application logic changes in Node/Express.
- Any runtime behavior changes beyond port configuration.

## Implementation Notes
- Keep all other environment variables unchanged.
- Ensure the container still runs as the non-root `node` user.

## Verification
1. Run `docker compose up -d --build`.
2. Open `http://localhost:6666` and confirm the login page loads.
3. Check logs: `docker compose logs -f dashboard`.

## Rollback Plan
- Revert the port mapping and `PORT` to 3000, or reset to the previous commit.
