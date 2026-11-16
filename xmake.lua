set_project("PiDeck-Q")

-- dist:win-native.mjs reads package.json once and passes this value through the
-- environment. Xmake's sandbox intentionally has no filesystem io API, so the
-- build orchestrator is the source-of-truth bridge instead of a second version file.
local package_version = os.getenv("PIDECK_VERSION") or "0.0.0-dev"
set_version(package_version)
set_languages("c++20")

add_rules("mode.debug", "mode.release")
add_repositories("pideck-local xmake-repo")

-- Node is a build tool for renderer/assets; the shipped application uses only the native backend.
add_requires("pideck-qt 6.11.2")

target("PiDeck-Q")
    set_kind("binary")
    add_packages("pideck-qt")
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
    add_deps("PiDeckBackend")
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
        os.mkdir(path.join(stage, "resources"))
        os.mkdir(path.join(stage, "resources", "extensions"))
        os.mkdir(path.join(stage, "resources", "extensions", "node_modules"))
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

        import("core.project.project")
        local backend = project.target("PiDeckBackend")
        os.cp(backend:targetfile(), stage)
        -- Deploy the backend's Qt modules too (notably QtSql and QtNetwork).
        os.vrunv(windeployqt, {
            deployMode,
            "--no-translations",
            "--dir", stage,
            backend:targetfile()
        })

        os.cp(path.join(os.projectdir(), "out", "renderer", "*"),
              path.join(stage, "app", "renderer"))

        os.cp(path.join(os.projectdir(), "resources", "*"), path.join(stage, "resources"))
        os.cp(path.join(os.projectdir(), "build", "icon.png"), path.join(stage, "icon.png"))

        -- Only extension dependencies are copied; the build machine's interpreter stays out.
        local stager = path.join(os.projectdir(), "scripts", "stage-extension-dependencies.mjs")
        local nodeCommand = os.getenv("PIDECK_NODE_EXE") or "node.exe"
        os.vrunv(nodeCommand, {
            stager,
            "--project-root", os.projectdir(),
            "--stage-root", stage,
        })
    end)

-- C++ sidecar staged beside PiDeck-Q.exe. It is built by default; the release
-- directory must not contain a bundled Node interpreter.
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

-- Gated file-read scheduling and shared worker shutdown budget. Never staged.
-- Exercised by tests/nativeBackgroundWork.test.mjs.
target("PiDeck-BackgroundWorkTest")
    set_kind("binary")
    set_default(false)
    add_packages("pideck-qt")
    add_files("native/tests/BackgroundWorkTest.cpp",
              "native/backend/process/BackgroundWork.cpp")
    add_includedirs("native/backend/process")
    if is_plat("windows") then
        add_cxxflags("/utf-8", "/Zc:__cplusplus", {force = true})
    end

-- Production todo projection and optimistic-command acknowledgement, without a pi process.
-- Never staged; exercised by tests/nativeTodoCommandProjection.test.mjs.
target("PiDeck-TodoCommandTest")
    set_kind("binary")
    set_default(false)
    add_packages("pideck-qt")
    add_files("native/tests/TodoCommandTest.cpp",
              "native/backend/domain/runtime/AgentTranscript*.cpp",
              "native/backend/domain/sessions/Projector.cpp",
              "native/backend/domain/sessions/PiTaskMessage.cpp",
              "native/backend/domain/sessions/SessionEntryIds.cpp",
              "native/backend/domain/sessions/AskQuestion.cpp",
              "native/backend/domain/sessions/ImageContent.cpp",
              "native/backend/domain/sessions/MessageContent.cpp",
              "native/backend/domain/sessions/ToolOutcome.cpp")
    add_includedirs("native/backend/domain/runtime", "native/backend/domain/sessions")

    if is_plat("windows") then
        add_cxxflags("/utf-8", "/Zc:__cplusplus", {force = true})
    end

-- Production transcript/projector regression, also exercised through the renderer's
-- real history reducer by tests/native2TranscriptHistory.test.mjs. Never staged.
target("PiDeck-TranscriptHistoryTest")
    set_kind("binary")
    set_default(false)
    add_packages("pideck-qt")
    add_files("native/tests/TranscriptHistoryTest.cpp",
              "native/backend/domain/runtime/AgentTranscript.cpp",
              "native/backend/domain/runtime/AgentTranscriptHistory.cpp",
              "native/backend/domain/sessions/Projector.cpp",
              "native/backend/domain/sessions/SessionEntryIds.cpp",
              "native/backend/domain/sessions/PiTaskMessage.cpp",
              "native/backend/domain/sessions/MessageContent.cpp",
              "native/backend/domain/sessions/ImageContent.cpp",
              "native/backend/domain/sessions/AskQuestion.cpp",
              "native/backend/domain/sessions/ToolOutcome.cpp")
    add_includedirs("native/backend/domain/runtime", "native/backend/domain/sessions")
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

-- File mapping and containment use production helpers without a WSL distribution.
-- Never staged; exercised by tests/nativeFilePathPolicy.test.mjs.
target("PiDeck-FilePathPolicyTest")
    set_kind("binary")
    set_default(false)
    add_packages("pideck-qt")
    add_files("native/tests/FilePathPolicyTest.cpp",
              "native/backend/domain/fs/PathPolicy.cpp",
              "native/backend/domain/wsl/WslFilePaths.cpp")
    add_includedirs("native/backend/domain/fs", "native/backend/domain/wsl")
    if is_plat("windows") then
        add_cxxflags("/utf-8", "/Zc:__cplusplus", {force = true})
    end

-- Production proxy policy and installed factory, without DNS or outbound requests.
-- Never staged; exercised by tests/nativeDesktopProxyPolicy.test.mjs.
target("PiDeck-DesktopProxyPolicyTest")
    set_kind("binary")
    set_default(false)
    add_packages("pideck-qt")
    add_files("native/tests/DesktopProxyPolicyTest.cpp",
              "native/backend/domain/net/DesktopProxy.cpp")
    add_includedirs("native/backend/domain/net")
    if is_plat("windows") then
        add_cxxflags("/utf-8", "/Zc:__cplusplus", {force = true})
    end

target("PiDeck-HostRpcTest")
    set_kind("binary")
    set_default(false)
    add_packages("pideck-qt")
    add_files("native/tests/HostRpcServerIntegration.cpp", "native/src/HostRpcServer.cpp", "native/src/FileDropController.cpp", "native/src/ClipboardController.cpp", "native/src/BackendProcessController.cpp", "native/src/NativePaths.cpp", "native/src/StartupWindowBounds.cpp")
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

-- Fast native regression for ConPTY EOF and shutdown with live shell descendants.
target("PiDeck-PtyLifecycleTest")
    set_kind("binary")
    set_default(false)
    add_packages("pideck-qt")
    add_files("native/tests/PtyLifecycleTest.cpp", "native/backend/domain/terminal/PtyProcessWindows.cpp")
    add_includedirs("native/backend/domain/terminal")
    if is_plat("windows") then
        add_cxxflags("/Zc:__cplusplus", {force = true})
    end
