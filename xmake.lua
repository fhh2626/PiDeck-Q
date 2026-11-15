set_project("PiDeck-Q")

-- dist:win-native.mjs reads package.json once and passes this value through the
-- environment. Xmake's sandbox intentionally has no filesystem io API, so the
-- build orchestrator is the source-of-truth bridge instead of a second version file.
local package_version = os.getenv("PIDECK_VERSION") or "0.0.0-dev"
set_version(package_version)
set_languages("c++20")

add_rules("mode.debug", "mode.release")
add_repositories("pideck-local xmake-repo")

-- The C++ backend is the packaged default (plan §47): a plain build stages and launches
-- PiDeckBackend.exe, so a double-clicked release needs no PIDECK_SIDECAR_KIND opt-in.
-- `PIDECK_SIDECAR_KIND=node` remains the documented compatibility build for the legacy
-- Node sidecar. Any other value is rejected here instead of producing a package whose
-- host cannot start.
local sidecar_kind = (os.getenv("PIDECK_SIDECAR_KIND") or "cpp"):lower()
local is_cpp = sidecar_kind == "cpp"
-- The packaged Node runtime is a dependency of the Node sidecar, not of the desktop
-- product. The default C++ package must not install, link or stage it at all (plan §11.2
-- item 2); staging still needs *a* Node executable to copy extension dependencies, but
-- that is the build machine's tool and never becomes part of the release directory.
local needs_node_runtime = not is_cpp

add_requires("pideck-qt 6.11.2")
if needs_node_runtime then
    add_requires("pideck-node-runtime 24.19.0")
end

target("PiDeck-Q")
    set_kind("binary")
    add_packages("pideck-qt")
    if needs_node_runtime then
        add_packages("pideck-node-runtime")
    end

    -- The project-description chunk has no fail-fast helper, but target hooks do: reject an
    -- unsupported kind during configure instead of staging a package whose host resolves no
    -- sidecar (or silently staging the Node one for a typo).
    on_load(function (target)
        if sidecar_kind ~= "cpp" and sidecar_kind ~= "node" then
            raise("PIDECK_SIDECAR_KIND must be 'cpp' (default) or 'node', got '" .. sidecar_kind .. "'")
        end
    end)

    -- Keep application metadata available on every platform even though the
    -- current prebuilt native SDK and staging pipeline are Windows-first.
    add_defines('PIDECK_BUILD_VERSION="' .. package_version .. '"')
    if is_plat("windows") then
        -- Qt 6.11 requires MSVC to expose the standard __cplusplus value.
        add_cxxflags("/Zc:__cplusplus", {force = true})
    end

    -- The launcher can override this explicitly for dev/staging runs. The
    -- compile-time default keeps a directly launched release binary packaged
    -- without inferring mode from whether a sidecar file happens to exist.
    add_defines(is_mode("release") and "PIDECK_NATIVE_PACKAGED=1" or "PIDECK_NATIVE_PACKAGED=0")
    -- The host resolves its sidecar from this compile-time kind, so the executable it
    -- starts is always the one this build staged beside it. PIDECK_SIDECAR_KIND still
    -- overrides the choice at launch (tests, recovery) and an unknown value is refused.
    add_defines('PIDECK_DEFAULT_SIDECAR_KIND="' .. sidecar_kind .. '"')
    if is_cpp then
        add_deps("PiDeckBackend")
    end
    add_files("native/src/**.cpp")
    add_includedirs("native/src")

    if is_plat("windows") then
        add_files("native/PiDeck-Q.rc")
        add_syslinks("user32", "shell32", "ole32", "advapi32", "propsys", "runtimeobject", "windowsapp")
        add_ldflags("/SUBSYSTEM:WINDOWS", {force = true})
    elseif is_plat("macosx") then
        add_files("native/src/MacDockReopenHandler.mm")
        add_frameworks("AppKit")
    end

    -- Portable Windows staging is intentionally platform-scoped. A plain
    -- macOS/Linux compile must never try to execute windeployqt.exe/node.exe.
    after_build(function (target)
        if not is_plat("windows") then return end
        -- PIDECK_STAGE_DIR lets measurement use another directory. The default
        -- remains release/win-unpacked, and that directory is still replaced.
        local stage = os.getenv("PIDECK_STAGE_DIR")
        if not stage or stage == "" then
            stage = path.join(os.projectdir(), "release", "win-unpacked")
        end
        os.rm(stage)
        os.mkdir(stage)
        os.mkdir(path.join(stage, "app"))
        -- `node/` only exists to hold the packaged Node executable, so a C++ stage must not
        -- even have the (empty) directory: `scripts/verify-build-artifacts.mjs` rejects it.
        if needs_node_runtime then
            os.mkdir(path.join(stage, "node"))
        end
        os.mkdir(path.join(stage, "resources"))
        os.mkdir(path.join(stage, "resources", "extensions"))
        os.mkdir(path.join(stage, "resources", "extensions", "node_modules"))
        -- Business Node code (bundled sidecar + its npm runtime) belongs to the Node
        -- package only; the built-in TS extensions below still need their own
        -- `resources/extensions/node_modules` (acorn/jiti/undici/yaml) in both kinds.
        if needs_node_runtime then
            os.mkdir(path.join(stage, "app", "native-node"))
            os.mkdir(path.join(stage, "app", "node_modules"))
        end
        os.mkdir(path.join(stage, "app", "renderer"))

        os.cp(target:targetfile(), stage)

        local qt = target:pkg("pideck-qt")
        local qtroot = path.join(qt:installdir(), "qt")
        local windeployqt = path.join(qtroot, "bin", "windeployqt.exe")
        -- Always deploy the RELEASE flavor, in debug builds too. The pideck-qt package
        -- links release Qt import libraries in both modes (verified: a `-m debug`
        -- PiDeckBackend.exe imports Qt6Core.dll / Qt6Sql.dll, not Qt6Cored.dll), so
        -- `windeployqt --debug` staged `Qt6Cored.dll` next to an executable that never
        -- references it: the debug stage could start and then die with
        -- STATUS_DLL_NOT_FOUND. The stage must contain the names the binary imports.
        local deployMode = "--release"
        os.vrunv(windeployqt, {
            deployMode,
            "--compiler-runtime",
            "--no-translations",
            "--dir", stage,
            target:targetfile()
        })

        -- windeployqt only deploys the plugin sets it can infer from the executable's
        -- imports, and it never ships SQL drivers. The catalog stage needs QSQLITE at
        -- runtime (prompt store, yao-prompts, model specs), so the driver is staged
        -- explicitly instead of depending on that heuristic.
        local sqlDrivers = path.join(qtroot, "plugins", "sqldrivers")
        -- Same reasoning as `deployMode`: a debug build runs against the release Qt
        -- runtime, so the plugin has to be the release build of the driver as well
        -- (a `qsqlited.dll` plugin next to release QtCore.dll cannot be loaded).
        local sqlDriverName = "qsqlite.dll"
        if os.isfile(path.join(sqlDrivers, sqlDriverName)) then
            os.mkdir(path.join(stage, "sqldrivers"))
            os.cp(path.join(sqlDrivers, sqlDriverName), path.join(stage, "sqldrivers"))
        else
            -- A missing driver must fail the stage: shipping a build whose catalog
            -- silently degrades to empty results is worse than failing here.
            raise("QSQLITE plugin not found at " .. path.join(sqlDrivers, sqlDriverName))
        end

        -- Do not ship node.exe. The stager below uses the build machine's
        -- Node only to copy extension dependencies; that executable stays out
        -- of the release directory.
        import("core.project.project")
        local node = target:pkg("pideck-node-runtime")
        if is_cpp then
            local backend = project.target("PiDeckBackend")
            os.cp(backend:targetfile(), stage)
            -- The host executable does not import QtSql: only PiDeckBackend does (OpenCode
            -- import, prompt store, model specs). windeployqt above therefore never deploys
            -- Qt6Sql(d).dll, and the sidecar used to die with STATUS_DLL_NOT_FOUND before
            -- its first RPC. Deploy the backend's own dependency set into the same stage.
            os.vrunv(windeployqt, {
                deployMode,
                "--no-translations",
                "--dir", stage,
                backend:targetfile()
            })
        else
            -- Compatibility build only: the Node sidecar needs its runtime in the stage
            -- or the app cannot start.
            os.cp(path.join(node:installdir(), "bin", "node.exe"), path.join(stage, "node"))
        end

        if needs_node_runtime then
            os.cp(path.join(os.projectdir(), "out", "native-node", "index.cjs"),
                  path.join(stage, "app", "native-node", "index.cjs"))
        end
        os.cp(path.join(os.projectdir(), "out", "renderer", "*"),
              path.join(stage, "app", "renderer"))

        os.cp(path.join(os.projectdir(), "resources", "*"), path.join(stage, "resources"))
        os.cp(path.join(os.projectdir(), "build", "icon.png"), path.join(stage, "icon.png"))

        -- Stage an explicit runtime allowlist instead of copying npm package
        -- directories wholesale. This keeps node-pty build debris, debug
        -- symbols, source maps, tests, and unused sql.js variants out of the
        -- portable release while preserving the Node ABI/native module layout.
        local runtimeStager = path.join(os.projectdir(), "scripts", "stage-native-runtime.mjs")
        -- A C++ stage does not install the Node runtime package (see the top of this file),
        -- so the stager runs on the build machine's Node. Only the extension dependency
        -- trees it copies land in the stage, never the interpreter.
        local nodeCommand = node and path.join(node:installdir(), "bin", "node.exe")
            or os.getenv("PIDECK_NODE_EXE") or "node.exe"
        os.vrunv(nodeCommand, {
            runtimeStager,
            "--project-root", os.projectdir(),
            "--stage-root", stage,
            "--sidecar-kind", sidecar_kind,
        })
    end)

-- C++ sidecar staged beside PiDeck-Q.exe. It is built by default; the release
-- directory must not contain node.exe in that mode.
target("PiDeckBackend")
    set_kind("binary")
    set_default(false)
    add_packages("pideck-qt")
    -- OpenCode import reads its SQLite history database through Qt Sql. The pinned
    -- pideck-qt package only publishes the modules the desktop host needs, so the
    -- extra module's headers/link dir are added here instead of widening the package.
    add_links("Qt6Sql", "Qt6Network")
    on_load(function (target)
        local pkgs = target:pkgs()
        local qt = pkgs and pkgs["pideck-qt"]
        local root = qt and path.join(qt:installdir(), "qt")
        if not root then return end
        target:add("includedirs", path.join(root, "include"), path.join(root, "include", "QtSql"))
        target:add("linkdirs", path.join(root, "lib"))
    end)
    add_files("native/backend/**.cpp")
    add_includedirs("native/backend", "native/backend/app", "native/backend/domain",
                    "native/backend/domain/fs", "native/backend/domain/git",
                    "native/backend/domain/runtime", "native/backend/domain/sessions", "native/backend/domain/terminal",
                    "native/backend/domain/os", "native/backend/domain/projects",
                    "native/backend/domain/config", "native/backend/domain/vision",
                    "native/backend/domain/scratchpad", "native/backend/domain/subagents",
                    "native/backend/domain/prompts", "native/backend/domain/skills",
                    "native/backend/domain/extensions", "native/backend/domain/market",
                    "native/backend/domain/logs", "native/backend/domain/usage",
                    "native/backend/domain/wsl",
                    "native/backend/pi", "native/backend/process", "native/backend/transport")

    if is_plat("windows") then
        -- Domain modules carry UTF-8 user-visible copy (localized error text), so the
        -- compiler must read sources and emit literals as UTF-8 rather than the
        -- machine's ANSI code page.
        add_cxxflags("/utf-8", "/Zc:__cplusplus", {force = true})
        add_syslinks("ws2_32", "psapi")
    end

-- Test-only `wsl.exe` stand-in for the WSL scan batch suite. It must be a native
-- executable: a `.cmd` shim is re-parsed by cmd.exe, which mangles the `sh -c` body
-- script the batch reader sends as one argument (see native/tests/FakeWslLauncher.cpp).
-- Never staged: PIDECK_WSL_EXE points at it only inside tests.
target("PiDeck-FakeWsl")
    set_kind("binary")
    set_default(false)
    add_packages("pideck-qt")
    add_files("native/tests/FakeWslLauncher.cpp")

    if is_plat("windows") then
        add_cxxflags("/utf-8", "/Zc:__cplusplus", {force = true})
    end

-- Deterministic unit test for the summary-cache write-ordering gate (`WriteOrdering`).
-- The end-to-end race (a debounced payload still queued when shutdown's flush writes a
-- newer snapshot) could not be constructed reliably through the public backend, so the
-- pure rule is exercised directly. Never staged: run by
-- tests/native2SummaryCacheWriteOrder.test.mjs.
target("PiDeck-SummaryCacheWriteOrderTest")
    set_kind("binary")
    set_default(false)
    add_packages("pideck-qt")
    add_files("native/tests/SummaryCacheWriteOrderTest.cpp",
              "native/backend/domain/sessions/WriteOrdering.cpp")
    add_includedirs("native/backend/domain/sessions")

    if is_plat("windows") then
        add_cxxflags("/utf-8", "/Zc:__cplusplus", {force = true})
    end

-- Real threaded regression for the session catalog's cross-thread ownership.
-- The backend reaches `SessionCatalogStore` from the Qt owner thread and from the
-- serial domain executor, so the race can only be reproduced with a real executable
-- that drives the production store from two threads. Compiles the store's production
-- translation units only (no backend process, no fake pi). Never staged: run by
-- tests/native2CatalogConcurrencyParity.test.mjs.
target("PiDeck-SessionCatalogConcurrencyTest")
    set_kind("binary")
    set_default(false)
    add_packages("pideck-qt")
    add_files("native/tests/SessionCatalogConcurrencyTest.cpp",
              "native/backend/domain/sessions/SessionCatalogStore.cpp",
              "native/backend/domain/sessions/SessionCatalogMerge.cpp",
              "native/backend/domain/sessions/CatalogRecords.cpp",
              "native/backend/domain/sessions/CatalogJson.cpp",
              "native/backend/domain/sessions/CatalogMigration.cpp",
              "native/backend/domain/sessions/SessionFiles.cpp",
              "native/backend/domain/sessions/SessionIdentity.cpp")
    add_includedirs("native/backend/domain", "native/backend/domain/sessions",
                    "native/backend/process")

    if is_plat("windows") then
        add_cxxflags("/utf-8", "/Zc:__cplusplus", {force = true})
    end

-- Deterministic regression for the file-drawer copy/read error handling. A real
-- short write needs a full volume or a failing device, so the fault is injected at the
-- QIODevice seam the production copy uses instead of being left untested. Compiles the
-- production CopyStream translation unit only. Never staged: run by
-- tests/native2CopyStreamWrite.test.mjs.
target("PiDeck-CopyStreamTest")
    set_kind("binary")
    set_default(false)
    add_packages("pideck-qt")
    add_files("native/tests/CopyStreamWriteTest.cpp",
              "native/backend/domain/fs/CopyStream.cpp")
    add_includedirs("native/backend/domain/fs", "native/backend/process")

    if is_plat("windows") then
        add_cxxflags("/utf-8", "/Zc:__cplusplus", {force = true})
    end

target("PiDeck-FakePi2")
    set_kind("binary")
    set_default(false)
    add_files("native/tests/Native2FakePi.cpp")

    if is_plat("windows") then
        add_cxxflags("/utf-8", "/Zc:__cplusplus", {force = true})
    end

target("PiDeck-HostRpcTest")
    set_kind("binary")
    set_default(false)
    add_packages("pideck-qt")
    add_files("native/tests/HostRpcServerIntegration.cpp", "native/src/HostRpcServer.cpp", "native/src/FileDropController.cpp", "native/src/ClipboardController.cpp", "native/src/NodeProcessController.cpp", "native/src/NativePaths.cpp", "native/src/StartupWindowBounds.cpp")
    add_includedirs("native/src")

    if is_plat("windows") then
        add_cxxflags("/Zc:__cplusplus", {force = true})
        add_syslinks("user32", "shell32", "ole32", "advapi32", "propsys", "runtimeobject", "windowsapp")
    end

target("PiDeck-NativeGuiTest")
    set_kind("binary")
    set_default(false)
    add_packages("pideck-qt")
    add_files("native/tests/NativeGuiIntegration.cpp", "native/src/MainWindow.cpp", "native/src/MainWebSurface.cpp", "native/src/FileDropController.cpp", "native/src/ClipboardController.cpp", "native/src/HostRpcServer.cpp", "native/src/NativeTheme.cpp", "native/src/NativeWindowPolicy.cpp", "native/src/WindowsToastNotifier.cpp", "native/src/StartupWindowBounds.cpp")
    add_includedirs("native/src")

    if is_plat("windows") then
        add_cxxflags("/Zc:__cplusplus", {force = true})
        add_syslinks("user32", "shell32", "ole32", "advapi32", "propsys", "runtimeobject", "windowsapp")
    end
