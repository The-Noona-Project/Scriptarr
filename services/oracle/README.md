# Oracle

Oracle is the Noona AI persona for Scriptarr.

Oracle starts disabled on install, defaults to OpenAI configuration, and stays read-only in v1. Moon admin can later
switch Oracle to a Warden-managed LocalAI runtime when the server admin is ready for the longer install or startup
time.

Oracle no longer talks directly to Vault or Warden. Its first-party Scriptarr reads now go through Sage's internal
broker routes, while external LLM traffic still goes directly to OpenAI or LocalAI.
