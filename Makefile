# pi-vcc extension — source-deployed
#
# pi loads pi-vcc directly from ~/src/pi-vcc (TypeScript source via tsgo).
# Changes to source take effect immediately — no deploy step needed.
# The deploy target exists as a backup/archive copy to the npm location.
#
# Usage:
#   make test        # run interface tests
#   make smoke-test  # quick-check the source candidate in a fresh pi process
#   make deploy      # copy, stamp, verify, and smoke-test the npm location
#   make verify      # check deploy content and stamp match source
#   make deployed-commit # show the deployed source commit

RUNTIME ?= $(HOME)/.pi/agent/npm/node_modules/@sting8k/pi-vcc
SOURCE ?= $(CURDIR)
SMOKE_SCRIPT ?= /home/dev/src/pi-session-analysis/scripts/predeploy_smoke.py
SMOKE_TIMEOUT ?= 90
PI_MONO ?= /home/dev/src/pi-mono
PI_CODING_AGENT ?= $(PI_MONO)/node_modules/@earendil-works/pi-coding-agent
PI_AI ?= $(PI_MONO)/node_modules/@earendil-works/pi-ai
PI_AGENT_CORE ?= $(PI_MONO)/node_modules/@earendil-works/pi-agent-core
PI_TUI ?= $(PI_MONO)/node_modules/@earendil-works/pi-tui

DEPLOY_FILES := index.ts package.json tsconfig.json README.md
DEPLOY_DIRS := src scripts tests

.PHONY: deploy verify deployed-commit link-packages test test-all smoke-test candidate-smoke-test runtime-smoke-test

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

candidate-smoke-test:  ## Load the source candidate in a fresh, isolated pi process
	python3 "$(SMOKE_SCRIPT)" \
	  --extension "$(SOURCE)/index.ts" \
	  --tool vcc_recall \
	  --timeout "$(SMOKE_TIMEOUT)" \
	  --prompt 'List your available tools, report that pi-vcc loaded, and stop.'

smoke-test: candidate-smoke-test  ## Smoke-test the source candidate (legacy target)

runtime-smoke-test:  ## Load the copied runtime extension in a fresh, isolated pi process
	python3 "$(SMOKE_SCRIPT)" \
	  --extension "$(RUNTIME)/index.ts" \
	  --tool vcc_recall \
	  --timeout "$(SMOKE_TIMEOUT)" \
	  --prompt 'List your available tools, report that pi-vcc loaded, and stop.'

deploy: ## Safely copy, stamp, verify, and smoke-test the npm location
	@test -z "$$(git -C "$(SOURCE)" status --porcelain)" || { echo "ERROR: commit source changes before deploying" >&2; git -C "$(SOURCE)" status --short >&2; exit 1; }
	@test ! -L "$(RUNTIME)" || { echo "ERROR: refusing to deploy through symlink $(RUNTIME)" >&2; exit 1; }
	@mkdir -p "$(RUNTIME)"
	@$(MAKE) --no-print-directory candidate-smoke-test
	@echo "Copying pi-vcc to $(RUNTIME)..."
	@for file in $(DEPLOY_FILES); do \
		if [ -f "$(SOURCE)/$$file" ]; then \
			cp "$(SOURCE)/$$file" "$(RUNTIME)/$$file"; \
		elif [ -e "$(RUNTIME)/$$file" ]; then \
			echo "ERROR: source file missing but runtime copy exists: $$file" >&2; exit 1; \
		fi; \
	done
	@for dir in $(DEPLOY_DIRS); do \
		if [ -d "$(SOURCE)/$$dir" ]; then \
			mkdir -p "$(RUNTIME)/$$dir"; cp -a "$(SOURCE)/$$dir/." "$(RUNTIME)/$$dir/"; \
		elif [ -e "$(RUNTIME)/$$dir" ]; then \
			echo "ERROR: source directory missing but runtime copy exists: $$dir" >&2; exit 1; \
		fi; \
	done
	@printf 'deployed from: %s\nbranch: %s\ncommit: %s\ndeployed at: %s\n\nThis is a deployed artifact. Do not edit files here.\nEdit the source checkout and run `make deploy`.\n' \
		"$(SOURCE)" "$$(git -C "$(SOURCE)" rev-parse --abbrev-ref HEAD)" "$$(git -C "$(SOURCE)" rev-parse HEAD)" "$$(date '+%Y-%m-%d %H:%M:%S %z')" \
		> "$(RUNTIME)/.deployed-commit"
	@$(MAKE) --no-print-directory verify
	@$(MAKE) --no-print-directory runtime-smoke-test
	@echo "Deploy complete."

verify: ## Check deployed files, content, and source commit stamp
	@test -d "$(RUNTIME)" || { echo "ERROR: $(RUNTIME) missing" >&2; exit 1; }
	@test -f "$(RUNTIME)/.deployed-commit" || { echo "ERROR: no .deployed-commit marker in $(RUNTIME)" >&2; exit 1; }
	@test "$$(sed -n 's/^commit: //p' "$(RUNTIME)/.deployed-commit")" = "$$(git -C "$(SOURCE)" rev-parse HEAD)" || { echo "ERROR: deployed commit != source HEAD" >&2; exit 1; }
	@for file in $(DEPLOY_FILES); do \
		if [ -f "$(SOURCE)/$$file" ]; then \
			cmp -s "$(SOURCE)/$$file" "$(RUNTIME)/$$file" || { echo "ERROR: deployed file drift: $$file" >&2; exit 1; }; \
		elif [ -e "$(RUNTIME)/$$file" ]; then \
			echo "ERROR: runtime has file absent from source: $$file" >&2; exit 1; \
		fi; \
	done
	@for dir in $(DEPLOY_DIRS); do \
		if [ -d "$(SOURCE)/$$dir" ]; then \
			diff -qr "$(SOURCE)/$$dir" "$(RUNTIME)/$$dir" >/dev/null || { echo "ERROR: deployed directory drift: $$dir" >&2; exit 1; }; \
		elif [ -e "$(RUNTIME)/$$dir" ]; then \
			echo "ERROR: runtime has directory absent from source: $$dir" >&2; exit 1; \
		fi; \
	done
	@echo "OK: $(RUNTIME) matches $(SOURCE) @ $$(git -C "$(SOURCE)" rev-parse --short HEAD)"

deployed-commit:  ## Show which source commit is deployed
	@cat "$(RUNTIME)/.deployed-commit" 2>/dev/null || echo "no .deployed-commit marker in $(RUNTIME)"
