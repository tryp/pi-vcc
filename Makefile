# pi-vcc extension — source development with optional runtime deployment
#
# pi-vcc is developed and tested from this source checkout. The deploy target
# publishes a separately verified copy for installations configured to load the
# npm runtime; deployment is optional when pi loads this source checkout.
#
# Usage:
#   make test             # run interface tests
#   make smoke-test       # quick-check the source candidate in a fresh pi process
#   make deploy           # copy, stamp, verify, and smoke-test the npm runtime
#   make verify           # check deploy content and stamp match source
#   make deployed-commit  # show the deployed source commit

RUNTIME ?= $(HOME)/.pi/agent/npm/node_modules/@sting8k/pi-vcc
SOURCE ?= $(CURDIR)
# Override this when pi-session-analysis is checked out elsewhere.
SMOKE_SCRIPT ?= $(HOME)/src/pi-session-analysis/scripts/predeploy_smoke.py
SMOKE_TIMEOUT ?= 90
PI_MONO ?= /home/dev/src/pi-mono
PI_CODING_AGENT ?= $(PI_MONO)/node_modules/@earendil-works/pi-coding-agent
PI_AI ?= $(PI_MONO)/node_modules/@earendil-works/pi-ai
PI_AGENT_CORE ?= $(PI_MONO)/node_modules/@earendil-works/pi-agent-core
PI_TUI ?= $(PI_MONO)/node_modules/@earendil-works/pi-tui

SOURCE_DIR := $(abspath $(SOURCE))
RUNTIME_DIR := $(abspath $(RUNTIME))
DEPLOY_FILES := index.ts package.json tsconfig.json README.md
DEPLOY_DIRS := src scripts tests

.PHONY: deploy deploy-preflight verify deployed-commit link-packages test test-all smoke-test candidate-smoke-test runtime-smoke-test

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

# Validate before any deploy-side effect. This intentionally rejects every
# symlink in the existing runtime and in the payload, not just the copied file.
deploy-preflight:
	@set -eu; \
		source="$(SOURCE_DIR)"; runtime="$(RUNTIME_DIR)"; \
		die() { echo "ERROR: $$*" >&2; exit 1; }; \
		reject_symlink_path() { \
			path="$$1"; \
			while [ "$$path" != "/" ]; do \
				[ ! -L "$$path" ] || die "refusing symlink path component: $$path"; \
				next="$${path%/*}"; \
				if [ -z "$$next" ] || [ "$$next" = "$$path" ]; then next=/; fi; \
				path="$$next"; \
			done; \
		}; \
		[ "$$source" != "$$runtime" ] || die "source and runtime must be different paths"; \
		reject_symlink_path "$$source"; \
		reject_symlink_path "$$runtime"; \
		[ -d "$$source" ] || die "source is not a directory: $$source"; \
		git_top="$$(git -C "$$source" rev-parse --show-toplevel 2>/dev/null)" || die "source is not inside a Git worktree: $$source"; \
		[ -n "$$git_top" ] || die "source is not inside a Git worktree: $$source"; \
		if [ -e "$$runtime" ] && [ ! -d "$$runtime" ]; then die "runtime is not a directory: $$runtime"; fi; \
		if [ -d "$$runtime" ]; then \
			link="$$(find -P "$$runtime" -type l -print -quit)"; \
			[ -z "$$link" ] || die "refusing symlink in runtime: $$link"; \
		fi; \
		for file in $(DEPLOY_FILES); do \
			path="$$source/$$file"; \
			[ ! -L "$$path" ] || die "refusing symlink source file: $$path"; \
			if [ -e "$$path" ] && [ ! -f "$$path" ]; then die "source file is not a regular file: $$path"; fi; \
		done; \
		for dir in $(DEPLOY_DIRS); do \
			path="$$source/$$dir"; \
			[ ! -L "$$path" ] || die "refusing symlink source directory: $$path"; \
			if [ -e "$$path" ] && [ ! -d "$$path" ]; then die "source directory is not a directory: $$path"; fi; \
			if [ -d "$$path" ]; then \
				link="$$(find -P "$$path" -type l -print -quit)"; \
				[ -z "$$link" ] || die "refusing symlink in source: $$link"; \
			fi; \
		done; \
		echo "OK: deploy preflight passed for $$source -> $$runtime"

candidate-smoke-test:  ## Load the source candidate in a fresh, isolated pi process
	@config_dir="$$(mktemp -d "$${TMPDIR:-/tmp}/pi-vcc-smoke-config.XXXXXX")"; \
		trap 'rm -rf "$$config_dir"' EXIT INT TERM; \
		PI_VCC_CONFIG_PATH="$$config_dir/pi-vcc-config.json" PI_TELEMETRY=0 python3 "$(SMOKE_SCRIPT)" \
		  --extension "$(SOURCE_DIR)/index.ts" \
		  --tool vcc_recall \
		  --timeout "$(SMOKE_TIMEOUT)" \
		  --prompt 'List your available tools, report that pi-vcc loaded, and stop.'

smoke-test: candidate-smoke-test  ## Smoke-test the source candidate (legacy target)

runtime-smoke-test:  ## Load the copied runtime extension in a fresh, isolated pi process
	@config_dir="$$(mktemp -d "$${TMPDIR:-/tmp}/pi-vcc-smoke-config.XXXXXX")"; \
		trap 'rm -rf "$$config_dir"' EXIT INT TERM; \
		PI_VCC_CONFIG_PATH="$$config_dir/pi-vcc-config.json" PI_TELEMETRY=0 python3 "$(SMOKE_SCRIPT)" \
		  --extension "$(RUNTIME_DIR)/index.ts" \
		  --tool vcc_recall \
		  --timeout "$(SMOKE_TIMEOUT)" \
		  --prompt 'List your available tools, report that pi-vcc loaded, and stop.'

deploy: deploy-preflight  ## Safely copy, stamp, verify, and smoke-test the npm runtime
	@test -z "$$(git -C "$(SOURCE_DIR)" status --porcelain)" || { echo "ERROR: commit source changes before deploying" >&2; git -C "$(SOURCE_DIR)" status --short >&2; exit 1; }
	@mkdir -p "$(RUNTIME_DIR)"
	@$(MAKE) --no-print-directory candidate-smoke-test
	@echo "Copying pi-vcc to $(RUNTIME_DIR)..."
	@for file in $(DEPLOY_FILES); do \
		if [ -f "$(SOURCE_DIR)/$$file" ]; then \
			cp "$(SOURCE_DIR)/$$file" "$(RUNTIME_DIR)/$$file"; \
		elif [ -e "$(RUNTIME_DIR)/$$file" ]; then \
			echo "ERROR: source file missing but runtime copy exists: $$file" >&2; exit 1; \
		fi; \
	done
	@for dir in $(DEPLOY_DIRS); do \
		if [ -d "$(SOURCE_DIR)/$$dir" ]; then \
			mkdir -p "$(RUNTIME_DIR)/$$dir"; cp -a "$(SOURCE_DIR)/$$dir/." "$(RUNTIME_DIR)/$$dir/"; \
		elif [ -e "$(RUNTIME_DIR)/$$dir" ]; then \
			echo "ERROR: source directory missing but runtime copy exists: $$dir" >&2; exit 1; \
		fi; \
	done
	@printf 'deployed from: %s\nbranch: %s\ncommit: %s\ndeployed at: %s\n\nThis is a deployed artifact. Do not edit files here.\nEdit the source checkout and run `make deploy`.\n' \
		"$(SOURCE_DIR)" "$$(git -C "$(SOURCE_DIR)" rev-parse --abbrev-ref HEAD)" "$$(git -C "$(SOURCE_DIR)" rev-parse HEAD)" "$$(date '+%Y-%m-%d %H:%M:%S %z')" \
		> "$(RUNTIME_DIR)/.deployed-commit"
	@$(MAKE) --no-print-directory verify
	@$(MAKE) --no-print-directory runtime-smoke-test
	@echo "Deploy complete."

verify: deploy-preflight  ## Check deployed files, content, and source commit stamp
	@test -d "$(RUNTIME_DIR)" || { echo "ERROR: $(RUNTIME_DIR) missing" >&2; exit 1; }
	@test -f "$(RUNTIME_DIR)/.deployed-commit" || { echo "ERROR: no .deployed-commit marker in $(RUNTIME_DIR)" >&2; exit 1; }
	@test "$$(sed -n 's/^commit: //p' "$(RUNTIME_DIR)/.deployed-commit")" = "$$(git -C "$(SOURCE_DIR)" rev-parse HEAD)" || { echo "ERROR: deployed commit != source HEAD" >&2; exit 1; }
	@for file in $(DEPLOY_FILES); do \
		if [ -f "$(SOURCE_DIR)/$$file" ]; then \
			cmp -s "$(SOURCE_DIR)/$$file" "$(RUNTIME_DIR)/$$file" || { echo "ERROR: deployed file drift: $$file" >&2; exit 1; }; \
		elif [ -e "$(RUNTIME_DIR)/$$file" ]; then \
			echo "ERROR: runtime has file absent from source: $$file" >&2; exit 1; \
		fi; \
	done
	@for dir in $(DEPLOY_DIRS); do \
		if [ -d "$(SOURCE_DIR)/$$dir" ]; then \
			diff -qr "$(SOURCE_DIR)/$$dir" "$(RUNTIME_DIR)/$$dir" >/dev/null || { echo "ERROR: deployed directory drift: $$dir" >&2; exit 1; }; \
		elif [ -e "$(RUNTIME_DIR)/$$dir" ]; then \
			echo "ERROR: runtime has directory absent from source: $$dir" >&2; exit 1; \
		fi; \
	done
	@echo "OK: $(RUNTIME_DIR) matches $(SOURCE_DIR) @ $$(git -C "$(SOURCE_DIR)" rev-parse --short HEAD)"

deployed-commit:  ## Show which source commit is deployed
	@cat "$(RUNTIME_DIR)/.deployed-commit" 2>/dev/null || echo "no .deployed-commit marker in $(RUNTIME_DIR)"
