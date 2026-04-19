from __future__ import annotations

import uvicorn

from oracle_service.app import create_app
from oracle_service.config import resolve_oracle_config

app = create_app()


if __name__ == "__main__":
    config = resolve_oracle_config()
    uvicorn.run(app, host="0.0.0.0", port=config.port)
