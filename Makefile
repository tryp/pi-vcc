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
PI_SESSION_ANALYSIS_DIR ?= $(HOME)/src/pi-session-analysis
RECORD_DEPLOY_ARGS ?=

# pi-mono packages linked into node_modules so tests resolve their imports.
#
# These use ordinary `PI_*` names, and the pi harness exports some of the same
# names for its own purposes (it sets PI_CODING_AGENT=true). An override may
# legitimately arrive through the environment - that is the documented transport
# for paths containing `$` - so an inherited value normally wins over the
# default. A non-path value then becomes an `ln -sfn` target, and `ln -sfn`
# happily creates a symlink to the literal string "true", silently corrupting
# node_modules for every later target that resolves imports through it.
#
# Resolve each path here instead: honour an override only when it names a
# directory, otherwise report it and use the default. link-packages-preflight
# still requires the resolved paths to exist, so a genuinely missing dependency
# fails loudly rather than being papered over.
dep_path = $(if $(1),$(if $(wildcard $(1)/.),$(1),$(2)),$(2))
warn_ignored_dep = $(if $(filter-out $(3),$(2)),$(warning ignoring $(1)=$(2): not a directory; using $(3)))

PI_CODING_AGENT_DEFAULT := $(PI_MONO)/node_modules/@earendil-works/pi-coding-agent
PI_AI_DEFAULT := $(PI_MONO)/node_modules/@earendil-works/pi-ai
PI_AGENT_CORE_DEFAULT := $(PI_MONO)/node_modules/@earendil-works/pi-agent-core
PI_TUI_DEFAULT := $(PI_MONO)/node_modules/@earendil-works/pi-tui

# Captured before resolution so an ignored override can be reported. A
# command-line assignment cannot be replaced by the makefile, so such a value
# reaches the recipes unchanged and is rejected by link-packages-preflight.
PI_CODING_AGENT_OVERRIDE := $(PI_CODING_AGENT)
PI_AI_OVERRIDE := $(PI_AI)
PI_AGENT_CORE_OVERRIDE := $(PI_AGENT_CORE)
PI_TUI_OVERRIDE := $(PI_TUI)

PI_CODING_AGENT := $(call dep_path,$(PI_CODING_AGENT_OVERRIDE),$(PI_CODING_AGENT_DEFAULT))
PI_AI := $(call dep_path,$(PI_AI_OVERRIDE),$(PI_AI_DEFAULT))
PI_AGENT_CORE := $(call dep_path,$(PI_AGENT_CORE_OVERRIDE),$(PI_AGENT_CORE_DEFAULT))
PI_TUI := $(call dep_path,$(PI_TUI_OVERRIDE),$(PI_TUI_DEFAULT))

$(call warn_ignored_dep,PI_CODING_AGENT,$(PI_CODING_AGENT_OVERRIDE),$(PI_CODING_AGENT))
$(call warn_ignored_dep,PI_AI,$(PI_AI_OVERRIDE),$(PI_AI))
$(call warn_ignored_dep,PI_AGENT_CORE,$(PI_AGENT_CORE_OVERRIDE),$(PI_AGENT_CORE))
$(call warn_ignored_dep,PI_TUI,$(PI_TUI_OVERRIDE),$(PI_TUI))

# Keep user-provided paths in the environment rather than interpolating them
# into recipe source. Recipes normalize them after the shell has received the
# values, preserving whitespace and treating metacharacters as data. For paths
# containing `$` or other GNU Make syntax, pass SOURCE/RUNTIME (and any other
# path override) in the environment, not as a command-line assignment:
#   SOURCE='/path/with/$/literal' RUNTIME='/path/to/runtime' make deploy-preflight
# Command-line assignments remain supported for ordinary paths, but GNU Make
# expands `$` in those assignments before recipes can receive it.
export SOURCE RUNTIME SMOKE_SCRIPT SMOKE_TIMEOUT PI_MONO PI_CODING_AGENT PI_AI PI_AGENT_CORE PI_TUI

DEPLOY_FILES := index.ts package.json tsconfig.json README.md
DEPLOY_DIRS := src scripts tests

.PHONY: deploy deploy-preflight path-overrides-preflight verify deployed-commit check-loaded link-packages link-packages-preflight test test-suite test-all smoke-test candidate-smoke-test runtime-smoke-test mutcheck-provenance e2e-provenance

# Reject bytes that POSIX command substitution would otherwise strip before
# path normalization. Keep this as a dependency of every target that consumes
# an override, so validation happens before that target's first substitution.
path-overrides-preflight:
	@python3 -c 'import sys; names = ("SOURCE", "RUNTIME", "SMOKE_SCRIPT", "PI_MONO", "PI_CODING_AGENT", "PI_AI", "PI_AGENT_CORE", "PI_TUI"); bad = next(((name, value) for name, value in zip(names, sys.argv[1:]) if "\n" in value or "\r" in value), None); sys.stderr.write(f"ERROR: {bad[0]} path override contains newline or carriage return\n") if bad else None; sys.exit(1 if bad else 0)' \
		"$${SOURCE}" "$${RUNTIME}" "$${SMOKE_SCRIPT}" "$${PI_MONO}" "$${PI_CODING_AGENT}" "$${PI_AI}" "$${PI_AGENT_CORE}" "$${PI_TUI}"

# Require the resolved dependency paths to be real directories. Resolution above
# already discards a non-directory environment value, so reaching this error
# means the pi-mono checkout itself is missing or was overridden on the command
# line with a non-path value. Failing here keeps `ln -sfn` from writing a
# symlink to a bogus target.
link-packages-preflight: path-overrides-preflight
	@python3 -c 'import os, sys; names = ("PI_CODING_AGENT", "PI_AI", "PI_AGENT_CORE", "PI_TUI"); pairs = tuple(zip(names, sys.argv[1:5])); bad = next(((n, v) for n, v in pairs if not os.path.isdir(v)), None); sys.stderr.write(f"ERROR: {bad[0]}={bad[1]!r} is not a directory; check the pi-mono checkout (PI_MONO={sys.argv[5]!r}) or the override passed on the command line\n") if bad else None; sys.exit(1 if bad else 0)' \
		"$${PI_CODING_AGENT}" "$${PI_AI}" "$${PI_AGENT_CORE}" "$${PI_TUI}" "$${PI_MONO}"

link-packages: link-packages-preflight
	@mkdir -p node_modules node_modules/@earendil-works node_modules/@mariozechner
	@rm -rf node_modules/typebox node_modules/@earendil-works/pi-coding-agent node_modules/@earendil-works/pi-ai node_modules/@earendil-works/pi-agent-core node_modules/@earendil-works/pi-tui node_modules/@mariozechner/pi-coding-agent
	@ln -sfn /home/dev/.pi/agent/npm/node_modules/typebox node_modules/typebox 2>/dev/null; echo "  [link] typebox"
	@ln -sfn "$${PI_CODING_AGENT}" node_modules/@earendil-works/pi-coding-agent 2>/dev/null; echo "  [link] @earendil-works/pi-coding-agent"
	@ln -sfn "$${PI_AI}" node_modules/@earendil-works/pi-ai 2>/dev/null; echo "  [link] @earendil-works/pi-ai"
	@ln -sfn "$${PI_AGENT_CORE}" node_modules/@earendil-works/pi-agent-core 2>/dev/null; echo "  [link] @earendil-works/pi-agent-core"
	@ln -sfn "$${PI_TUI}" node_modules/@earendil-works/pi-tui 2>/dev/null; echo "  [link] @earendil-works/pi-tui"
	@ln -sfn "$${PI_CODING_AGENT}" node_modules/@mariozechner/pi-coding-agent 2>/dev/null; echo "  [link] @mariozechner/pi-coding-agent"

BUN ?= bun

test: link-packages  ## Run interface tests
	$(BUN) test tests/interface.test.ts

# The full suite covers provenance, compaction, ranking, and recall. `make test`
# runs only the interface file, so use this before deploying a summarizer change.
test-suite: link-packages  ## Run the whole test suite
	$(BUN) test tests/

# Revert each provenance guarantee in a throwaway copy and require a test to
# fail. A green suite proves nothing on its own: a mutation that survives means
# nothing observes the behaviour it was supposed to protect. A mutation that
# does not apply, or does not compile, is a SETUP-ERROR rather than a catch --
# otherwise the harness reports coverage it does not have.
mutcheck-provenance: link-packages  ## Revert each provenance guarantee; all must fail
	python3 scripts/mutcheck-provenance.py

E2E_DIR ?= $(CURDIR)/tmp/e2e-provenance
E2E_SESSIONS ?= $(E2E_DIR)/sessions

# Drive a synthetic session_before_compact through the hook that a REAL pi
# process registered, against payloads copied from session files. Costs one pi
# startup; catches the hook flattening its input (a stub cannot).
e2e-provenance: link-packages  ## Load the candidate in real pi and check the emitted summary
	@set -eu; \
	rm -rf "$(E2E_DIR)"; mkdir -p "$(E2E_SESSIONS)"; \
	config="$(E2E_DIR)/pi-vcc-config.json"; \
	PI_VCC_CONFIG_PATH="$$config" PI_SERVE_PORT= PI_TELEMETRY=0 \
	  pi --session-dir "$(E2E_SESSIONS)" --no-session --no-extensions \
	     -e "scripts/e2e-provenance.ts" -p "run the provenance check" </dev/null 2>&1 \
	  | tee "$(E2E_DIR)/pi.log" \
	  | sed -n '/---- summary emitted/,/E2E_PROVENANCE_/p'; \
	if ! grep -q "E2E_PROVENANCE_PASS" "$(E2E_DIR)/pi.log"; then \
	  echo "ERROR: e2e-provenance did not pass; see $(E2E_DIR)/pi.log" >&2; \
	  grep "E2E_PROVENANCE_FAIL\|- " "$(E2E_DIR)/pi.log" >&2 || true; \
	  exit 1; \
	fi; \
	echo "e2e-provenance: pass"

test-all: test smoke-test  ## Run all tests

# Validate before any deploy-side effect. This intentionally rejects every
# symlink in the existing runtime and in the payload, not just the copied file.
deploy-preflight: path-overrides-preflight
	@set -eu; \
		source="$$(python3 -c 'import os, sys; print(os.path.abspath(sys.argv[1]))' "$${SOURCE}")"; \
		runtime="$$(python3 -c 'import os, sys; print(os.path.abspath(sys.argv[1]))' "$${RUNTIME}")"; \
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
		path_is_ancestor() { \
			ancestor="$$1"; child="$$2"; \
			[ "$$ancestor" = "$$child" ] && return 0; \
			if [ "$$ancestor" = / ]; then \
				case "$$child" in /*) return 0;; esac; \
			else \
				case "$$child" in "$$ancestor"/*) return 0;; esac; \
			fi; \
			return 1; \
		}; \
		[ "$$source" != "$$runtime" ] || die "source and runtime must be different paths"; \
		if path_is_ancestor "$$source" "$$runtime" || path_is_ancestor "$$runtime" "$$source"; then \
			die "source and runtime paths must not overlap: $$source and $$runtime"; \
		fi; \
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

candidate-smoke-test: path-overrides-preflight  ## Load the source candidate in a fresh, isolated pi process
	@set -eu; \
		source="$$(python3 -c 'import os, sys; print(os.path.abspath(sys.argv[1]))' "$${SOURCE}")"; \
		config_dir="$$(mktemp -d "$${TMPDIR:-/tmp}/pi-vcc-smoke-config.XXXXXX")"; \
		trap 'rm -rf "$$config_dir"' EXIT INT TERM; \
		PI_VCC_CONFIG_PATH="$$config_dir/pi-vcc-config.json" PI_TELEMETRY=0 python3 "$${SMOKE_SCRIPT}" \
		  --extension "$$source/index.ts" \
		  --tool vcc_recall \
		  --timeout "$${SMOKE_TIMEOUT}" \
		  --prompt 'List your available tools, report that pi-vcc loaded, and stop.'

smoke-test: candidate-smoke-test  ## Smoke-test the source candidate (legacy target)

runtime-smoke-test: path-overrides-preflight  ## Load the copied runtime extension in a fresh, isolated pi process
	@set -eu; \
		runtime="$$(python3 -c 'import os, sys; print(os.path.abspath(sys.argv[1]))' "$${RUNTIME}")"; \
		config_dir="$$(mktemp -d "$${TMPDIR:-/tmp}/pi-vcc-smoke-config.XXXXXX")"; \
		trap 'rm -rf "$$config_dir"' EXIT INT TERM; \
		PI_VCC_CONFIG_PATH="$$config_dir/pi-vcc-config.json" PI_TELEMETRY=0 python3 "$${SMOKE_SCRIPT}" \
		  --extension "$$runtime/index.ts" \
		  --tool vcc_recall \
		  --timeout "$${SMOKE_TIMEOUT}" \
		  --prompt 'List your available tools, report that pi-vcc loaded, and stop.'

deploy: deploy-preflight  ## Safely copy, stamp, verify, and smoke-test the npm runtime
	@set -eu; \
		source="$$(python3 -c 'import os, sys; print(os.path.abspath(sys.argv[1]))' "$${SOURCE}")"; \
		runtime="$$(python3 -c 'import os, sys; print(os.path.abspath(sys.argv[1]))' "$${RUNTIME}")"; \
		test -z "$$(git -C "$$source" status --porcelain)" || { echo "ERROR: commit source changes before deploying" >&2; git -C "$$source" status --short >&2; exit 1; }; \
		mkdir -p "$$runtime"; \
		$(MAKE) --no-print-directory candidate-smoke-test; \
		echo "Copying pi-vcc to $$runtime..."; \
		for file in $(DEPLOY_FILES); do \
			if [ -f "$$source/$$file" ]; then \
				cp "$$source/$$file" "$$runtime/$$file"; \
			elif [ -e "$$runtime/$$file" ]; then \
				echo "ERROR: source file missing but runtime copy exists: $$file" >&2; exit 1; \
			fi; \
		done; \
		for dir in $(DEPLOY_DIRS); do \
			if [ -d "$$source/$$dir" ]; then \
				mkdir -p "$$runtime/$$dir"; cp -a "$$source/$$dir/." "$$runtime/$$dir/"; \
			elif [ -e "$$runtime/$$dir" ]; then \
				echo "ERROR: source directory missing but runtime copy exists: $$dir" >&2; exit 1; \
			fi; \
		done; \
		printf 'deployed from: %s\nbranch: %s\ncommit: %s\ndeployed at: %s\n\nThis is a deployed artifact. Do not edit files here.\nEdit the source checkout and run `make deploy`.\n' \
			"$$source" "$$(git -C "$$source" rev-parse --abbrev-ref HEAD)" "$$(git -C "$$source" rev-parse HEAD)" "$$(date '+%Y-%m-%d %H:%M:%S %z')" \
			> "$$runtime/.deployed-commit"; \
		$(MAKE) --no-print-directory verify; \
		$(MAKE) --no-print-directory runtime-smoke-test; \
		if [ -x "$(PI_SESSION_ANALYSIS_DIR)/scripts/record-deploy" ]; then \
			"$(PI_SESSION_ANALYSIS_DIR)/scripts/record-deploy" $(RECORD_DEPLOY_ARGS); \
		else \
			echo "Skipping deploy ledger recording: recorder not found at $(PI_SESSION_ANALYSIS_DIR)/scripts/record-deploy."; \
		fi; \
		echo "Deploy complete."

verify: deploy-preflight  ## Check deployed files, content, and source commit stamp
	@set -eu; \
		source="$$(python3 -c 'import os, sys; print(os.path.abspath(sys.argv[1]))' "$${SOURCE}")"; \
		runtime="$$(python3 -c 'import os, sys; print(os.path.abspath(sys.argv[1]))' "$${RUNTIME}")"; \
		test -d "$$runtime" || { echo "ERROR: $$runtime missing" >&2; exit 1; }; \
		test -f "$$runtime/.deployed-commit" || { echo "ERROR: no .deployed-commit marker in $$runtime" >&2; exit 1; }; \
		test "$$(sed -n 's/^commit: //p' "$$runtime/.deployed-commit")" = "$$(git -C "$$source" rev-parse HEAD)" || { echo "ERROR: deployed commit != source HEAD" >&2; exit 1; }; \
		for file in $(DEPLOY_FILES); do \
			if [ -f "$$source/$$file" ]; then \
				cmp -s "$$source/$$file" "$$runtime/$$file" || { echo "ERROR: deployed file drift: $$file" >&2; exit 1; }; \
			elif [ -e "$$runtime/$$file" ]; then \
				echo "ERROR: runtime has file absent from source: $$file" >&2; exit 1; \
			fi; \
		done; \
		for dir in $(DEPLOY_DIRS); do \
			if [ -d "$$source/$$dir" ]; then \
				diff -qr "$$source/$$dir" "$$runtime/$$dir" >/dev/null || { echo "ERROR: deployed directory drift: $$dir" >&2; exit 1; }; \
			elif [ -e "$$runtime/$$dir" ]; then \
				echo "ERROR: runtime has directory absent from source: $$dir" >&2; exit 1; \
			fi; \
		done; \
		echo "OK: $$runtime matches $$source @ $$(git -C "$$source" rev-parse --short HEAD)"

deployed-commit: path-overrides-preflight  ## Show which source commit is deployed
	@runtime="$$(python3 -c 'import os, sys; print(os.path.abspath(sys.argv[1]))' "$${RUNTIME}")"; \
		cat "$$runtime/.deployed-commit" 2>/dev/null || echo "no .deployed-commit marker in $$runtime"

# pi loads this checkout in place: the user settings `packages` list the source
# path, and `pi list` resolves it to itself, so the source tree IS the live
# extension and `make deploy` is optional (it publishes a copy only for
# installations configured to load the npm runtime). This target turns that
# into something checkable rather than a convention. It fails when pi resolves
# pi-vcc somewhere else, and when the npm package is registered again, since
# upstream's published code would then shadow this checkout.
check-loaded: path-overrides-preflight  ## Verify pi loads this checkout in place
	@set -eu; \
		source="$$(python3 -c 'import os, sys; print(os.path.abspath(sys.argv[1]))' "$${SOURCE}")"; \
		listed="$$(pi list 2>/dev/null || true)"; \
		resolved="$$(printf '%s\n' "$$listed" | awk -v want="$$source" 'index($$0, want) == 3 { getline; gsub(/^[[:space:]]+/, ""); print; exit }')"; \
		test -n "$$resolved" || { echo "ERROR: pi does not list $$source as a package (run: pi install $$source)" >&2; exit 1; }; \
		test "$$resolved" = "$$source" || { echo "ERROR: pi loads pi-vcc from '$$resolved', not '$$source'" >&2; exit 1; }; \
		if printf '%s\n' "$$listed" | grep -q 'npm:@sting8k/pi-vcc'; then \
			echo "ERROR: npm:@sting8k/pi-vcc is registered in pi settings; remove it so upstream cannot shadow this checkout" >&2; \
			exit 1; \
		fi; \
		echo "OK: pi loads pi-vcc in place from $$source"
