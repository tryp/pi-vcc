# pi-vcc extension — source-deployed
#
# pi loads pi-vcc directly from ~/src/pi-vcc (TypeScript source via tsgo).
# Changes to source take effect immediately — no deploy step needed.
# The deploy target exists as a backup/archive copy to the npm location.
#
# Usage:
#   make test        # run interface tests
#   make smoke-test  # quick-check extension loads in a real pi session
#   make deploy      # backup copy to npm location (not required)
#   make verify      # check deploy matches source

RUNTIME = $(HOME)/.pi/agent/npm/node_modules/@sting8k/pi-vcc
SOURCE = $(HOME)/src/pi-vcc

.PHONY: deploy verify link-packages test test-all smoke-test

link-packages:
	@mkdir -p node_modules
	@ln -sfn /home/dev/.pi/agent/npm/node_modules/typebox node_modules/typebox 2>/dev/null; echo "  [link] typebox"

TSX = /home/dev/src/pi-mono/node_modules/.bin/tsx

test: link-packages  ## Run interface tests
	$(TSX) --test tests/interface.test.ts

test-all: test smoke-test  ## Run all tests

smoke-test:  ## Check extension loads in a real pi session
	@echo "Smoke testing pi-vcc extension in pi..."
	@rm -f /tmp/pi-vcc-smoke.jsonl
	@(timeout 120 pi --mode json --no-session -p "list your available tools" > /tmp/pi-vcc-smoke.jsonl 2>&1) &
	@PID=$$!; \
	  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do \
	    if grep -q 'vcc_recall' /tmp/pi-vcc-smoke.jsonl 2>/dev/null; then \
	      echo "  OK: vcc_recall tool found in pi output"; \
	      kill $$PID 2>/dev/null; exit 0; \
	    fi; \
	    sleep 2; \
	  done; \
	  echo "  WARN: pi not responding — check /tmp/pi-vcc-smoke.jsonl"; \
	  kill $$PID 2>/dev/null; exit 1

deploy: ## Backup copy to npm location (not required — pi loads from source)
	@echo "Backing up pi-vcc to $(RUNTIME)..."
	cp "$(SOURCE)/index.ts" "$(RUNTIME)/index.ts"
	cp "$(SOURCE)/package.json" "$(RUNTIME)/package.json"
	cp "$(SOURCE)/tsconfig.json" "$(RUNTIME)/tsconfig.json" 2>/dev/null || true
	cp "$(SOURCE)/README.md" "$(RUNTIME)/README.md" 2>/dev/null || true
	rm -rf "$(RUNTIME)/src" "$(RUNTIME)/scripts" "$(RUNTIME)/tests"
	cp -a "$(SOURCE)/src" "$(RUNTIME)/src"
	[ -d "$(SOURCE)/scripts" ] && cp -a "$(SOURCE)/scripts" "$(RUNTIME)/scripts"
	[ -d "$(SOURCE)/tests" ] && cp -a "$(SOURCE)/tests" "$(RUNTIME)/tests"
	@echo "Done. Verify with 'make verify'"

verify: ## Check deployed files match source
	@echo "Verifying pi-vcc deploy..."
	@diff -q "$(SOURCE)/index.ts" "$(RUNTIME)/index.ts" && \
	  echo "  index.ts: OK" || echo "  index.ts: MISMATCH"
	@diff -q "$(SOURCE)/src/tools/recall.ts" "$(RUNTIME)/src/tools/recall.ts" && \
	  echo "  src/tools/recall.ts: OK" || echo "  src/tools/recall.ts: MISMATCH"
	@echo "Verify complete"
