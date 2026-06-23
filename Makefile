# Carrier — local development.
#
#   make dev     set up (if needed) and run the whole stack locally:
#                Carrier runtime + BFF + web, on "3"-prefixed ports.
#   make setup   install Go + web dependencies only.
#   make kill    free the dev ports.
#   make clean   remove local dev state (.carrier-dev).
#
# Ports (override on the command line, e.g. `make dev WEB_PORT=45173`):
#   web      35173   bff      38787   carrier  39099
# The database is embedded PGlite (persisted under .carrier-dev/pgdata) — there
# is no separate database port.

WEB_PORT     ?= 35173
BFF_PORT     ?= 38787
CARRIER_PORT ?= 39099

export WEB_PORT BFF_PORT CARRIER_PORT

.PHONY: dev setup kill clean

dev: setup
	@bash scripts/dev.sh

setup:
	@command -v pnpm >/dev/null 2>&1 || { echo "pnpm not found — run: corepack enable"; exit 1; }
	@echo "▸ go mod download"
	@go mod download
	@echo "▸ pnpm install (web)"
	@cd web && pnpm install --frozen-lockfile

kill:
	@for p in $(WEB_PORT) $(BFF_PORT) $(CARRIER_PORT); do \
	  pids=$$(lsof -ti tcp:$$p 2>/dev/null); \
	  if [ -n "$$pids" ]; then echo "▸ killing port $$p ($$pids)"; kill -9 $$pids 2>/dev/null || true; fi; \
	done

clean: kill
	@rm -rf .carrier-dev
	@echo "▸ removed .carrier-dev"
