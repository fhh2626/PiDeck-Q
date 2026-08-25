package("pideck-node-runtime")
    set_kind("binary")
    set_homepage("https://nodejs.org/")
    set_description("Pinned Node.js 24.19.0 runtime for PiDeck-Q")
    set_urls("https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip")
    add_versions("24.19.0", "57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73")

    on_install(function (package)
        import("lib.detect.find_tool")
        local sevenZip = find_tool("7z")
        if not sevenZip then raise("pideck-node-runtime requires 7z") end
        local source = package:originfile()
        if not source or not os.isfile(source) then
            raise("Node 24.19.0 runtime archive was not downloaded")
        end
        local extractDir = path.join(package:builddir(), "node")
        os.mkdir(extractDir)
        os.vrunv(sevenZip.program, {"x", "-y", "-o" .. extractDir, source})
        local root = path.join(extractDir, "node-v24.19.0-win-x64")
        if not os.isfile(path.join(root, "node.exe")) then
            raise("Node runtime archive has unexpected layout")
        end
        os.cp(path.join(root, "node.exe"), package:installdir("bin"))
    end)

    on_load(function (package)
        package:addenv("PATH", package:installdir("bin"))
        package:set("runtimebindir", package:installdir("bin"))
    end)
