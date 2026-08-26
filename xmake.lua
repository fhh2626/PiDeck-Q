set_project("PiDeck-Q")

-- dist:win-native.mjs reads package.json once and passes this value through the
-- environment. Xmake's sandbox intentionally has no filesystem io API, so the
-- build orchestrator is the source-of-truth bridge instead of a second version file.
local package_version = os.getenv("PIDECK_VERSION") or "0.0.0-dev"
set_version(package_version)
set_languages("c++20")

add_rules("mode.debug", "mode.release")
add_repositories("pideck-local xmake-repo")

add_requires("pideck-qt 6.11.2")
add_requires("pideck-node-runtime 24.19.0")

target("PiDeck-Q")
    set_kind("binary")
    add_packages("pideck-qt", "pideck-node-runtime")

    if is_plat("windows") then
        -- Qt 6.11 requires MSVC to expose the standard __cplusplus value.
        add_cxxflags("/Zc:__cplusplus", {force = true})
        add_defines('PIDECK_BUILD_VERSION="' .. package_version .. '"')
    end

    -- The launcher can override this explicitly for dev/staging runs. The
    -- compile-time default keeps a directly launched release binary packaged
    -- without inferring mode from whether a sidecar file happens to exist.
    add_defines(is_mode("release") and "PIDECK_NATIVE_PACKAGED=1" or "PIDECK_NATIVE_PACKAGED=0")
    add_files("native/src/**.cpp")
    add_includedirs("native/src")

    if is_plat("windows") then
        add_files("native/PiDeck-Q.rc")
        add_syslinks("user32", "shell32", "ole32", "advapi32", "runtimeobject", "windowsapp")
        add_ldflags("/SUBSYSTEM:WINDOWS", {force = true})
    end

    after_build(function (target)
        local stage = path.join(os.projectdir(), "release", "win-unpacked")
        os.rm(stage)
        os.mkdir(stage)
        os.mkdir(path.join(stage, "app"))
        os.mkdir(path.join(stage, "node"))
        os.mkdir(path.join(stage, "resources"))
        os.mkdir(path.join(stage, "resources", "extensions"))
        os.mkdir(path.join(stage, "resources", "extensions", "node_modules"))
        os.mkdir(path.join(stage, "app", "native-node"))
        os.mkdir(path.join(stage, "app", "node_modules"))
        os.mkdir(path.join(stage, "app", "renderer"))

        os.cp(target:targetfile(), stage)

        local qt = target:pkg("pideck-qt")
        local qtroot = path.join(qt:installdir(), "qt")
        local windeployqt = path.join(qtroot, "bin", "windeployqt.exe")
        local deployMode = is_mode("debug") and "--debug" or "--release"
        os.vrunv(windeployqt, {
            deployMode,
            "--compiler-runtime",
            "--no-translations",
            "--dir", stage,
            target:targetfile()
        })

        local node = target:pkg("pideck-node-runtime")
        os.cp(path.join(node:installdir(), "bin", "node.exe"), path.join(stage, "node"))

        os.cp(path.join(os.projectdir(), "out", "native-node", "index.cjs"),
              path.join(stage, "app", "native-node", "index.cjs"))
        os.cp(path.join(os.projectdir(), "out", "renderer", "*"),
              path.join(stage, "app", "renderer"))

        os.cp(path.join(os.projectdir(), "resources", "*"), path.join(stage, "resources"))
        os.cp(path.join(os.projectdir(), "build", "icon.png"), path.join(stage, "icon.png"))

        -- Stage an explicit runtime allowlist instead of copying npm package
        -- directories wholesale. This keeps node-pty build debris, debug
        -- symbols, source maps, tests, and unused sql.js variants out of the
        -- portable release while preserving the Node ABI/native module layout.
        local runtimeStager = path.join(os.projectdir(), "scripts", "stage-native-runtime.mjs")
        local nodeCommand = path.join(node:installdir(), "bin", "node.exe")
        os.vrunv(nodeCommand, {
            runtimeStager,
            "--project-root", os.projectdir(),
            "--stage-root", stage,
        })
    end)
