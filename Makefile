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

RUNTIME ?= $(HOME)/.pi/agent/npm/node_modules/@sting8k/pi-vcc
SOURCE ?= $(CURDIR)
PI_MONO ?= /home/dev/src/pi-mono
PI_CODING_AGENT ?= $(PI_MONO)/node_modules/@earendil-works/pi-coding-agent
PI_AI ?= $(PI_MONO)/node_modules/@earendil-works/pi-ai
PI_AGENT_CORE ?= $(PI_MONO)/node_modules/@earendil-works/pi-agent-core
PI_TUI ?= $(PI_MONO)/node_modules/@earendil-works/pi-tui

.PHONY: deploy verify link-packages test test-all smoke-test

link-packages:
	@mkdir -p node_modules node_modules/@earendil-works node_modules/@mariozechner
	@rm -rf node_modules/typebox node_modules/@earendil-works/pi-coding-agent node_modules/@earendil-works/pi-ai node_modules/@earendil-works/pi-agent-core node_modules/@earendil-works/pi-tui node_modules/@mariozechner/pi-coding-agent
	@ln -sfn /home/dev/.pi/agent/npm/node_modules/typebox node_modules/typebox 2>/dev/null; echo "  [link] typebox"
	@ln -sfn "$(PI_CODING_AGENT)" node_modules/@earendil-works/pi-coding-agent 2>/dev/null; echo "  [link] @earendil-works/pi-coding-agent"
	@ln -sfn "$(PI_AI)" node_modules/@earendil-works/pi-ai 2>/dev/null; echo "  [link] @earendil-works/pi-ai"
	@ln -sfn "$(PI_AGENT_CORE)" node_modules/@earendil-works/pi-agent-core 2>/dev/null; echo "  [link] @earendil-works/pi-agent-core"
	@ln -sfn "$(PI_TUI)" node_modules/@earendil-works/pi-tui 2>/dev/null; echo "  [link] @earendil-works/pi-tui"
	@ln -sfn "$(PI_CODING_AGENT)" node_modules/@mariozechner/pi-coding-agent 2>/dev/null; echo "  [link] @mariozechner/pi-coding-agent"

BUN ?= bun

test: link-packages  ## Run interface tests
	$(BUN) test tests/interface.test.ts

test-all: test smoke-test  ## Run all tests

smoke-test:  ## Check extension loads in a real pi session
	@echo "Smoke testing pi-vcc extension in pi..."
	@rm -f /tmp/pi-vcc-smoke.jsonl
	@(timeout 120 pi --mode json --no-extensions --extension "$(SOURCE)/index.ts" --no-session -p "list your available tools" > /tmp/pi-vcc-smoke.jsonl 2>&1) &
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
