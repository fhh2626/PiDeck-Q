package("pideck-qt")
    set_kind("library")
    set_homepage("https://www.qt.io/")
    set_description("Pinned Qt 6.11.2 SDK with the Qt WebView module for PiDeck-Q")
    add_versions("6.11.2", "pideck-pinned-qt-sdk")

    on_install(function (package)
        local download = import("net.http.download")
        import("lib.detect.find_tool")

        -- Qt 6.11 changed the Windows repository layout. aqt 3.3.0 still
        -- requests the old <version>/<version>/Updates.xml path. Keep Xmake
        -- as the package orchestrator, but resolve the official archives
        -- directly and pin the exact archive set below.
        local repository = "https://download.qt.io/online/qtsdkrepository/windows_x86/desktop/qt6_6112/qt6_6112_msvc2022_64"
        local baseDirectory = repository .. "/qt.qt6.6112.win64_msvc2022_64/"
        local webViewDirectory = repository .. "/qt.qt6.6112.addons.qtwebview.win64_msvc2022_64/"
        local archives = {
            {directory = baseDirectory, name = "6.11.2-0-202608131017qttranslations-Windows-Windows_11_24H2-MSVC2022-Windows-Windows_11_24H2-X86_64.7z", sha1 = "2826dd1fcb9489d243c25a812f3edd7319ca2e45"},
            {directory = baseDirectory, name = "6.11.2-0-202608131017qttools-Windows-Windows_11_24H2-MSVC2022-Windows-Windows_11_24H2-X86_64.7z", sha1 = "0a94da47fb97103660b5bfec7361ae51b05f7323"},
            {directory = baseDirectory, name = "6.11.2-0-202608131017qtsvg-Windows-Windows_11_24H2-MSVC2022-Windows-Windows_11_24H2-X86_64.7z", sha1 = "f458d7f238795d61a3e53fa5211cf2d6b1aa08ef"},
            {directory = baseDirectory, name = "6.11.2-0-202608131017qtdoc-Windows-Windows_11_24H2-MSVC2022-Windows-Windows_11_24H2-X86_64.7z", sha1 = "675bf1eee1945d334e05d22232893065d1423df6"},
            {directory = baseDirectory, name = "6.11.2-0-202608131017qtdeclarative-Windows-Windows_11_24H2-MSVC2022-Windows-Windows_11_24H2-X86_64.7z", sha1 = "f3ac5149eb76cb0279ba84e126734cf520214519"},
            {directory = baseDirectory, name = "6.11.2-0-202608131017qtbase-Windows-Windows_11_24H2-MSVC2022-Windows-Windows_11_24H2-X86_64.7z", sha1 = "1fca9483183d426c1a3a984f1382382fa51f48de"},
            {directory = baseDirectory, name = "6.11.2-0-202608131017opengl32sw-64-mesa_11_2_2-signed_sha256.7z", sha1 = "753a1934e93a7402ce1584b71212f38c45770d3c"},
            {directory = baseDirectory, name = "6.11.2-0-202608131017d3dcompiler_47-x64.7z", sha1 = "15012129f9503b4cefdb1bc8a82d0ff42efc10e6"},
            {directory = webViewDirectory, name = "6.11.2-0-202608131017qtwebview-Windows-Windows_11_24H2-MSVC2022-Windows-Windows_11_24H2-X86_64.7z", sha1 = "b4fee2f4c0a7a4a1c59ee9fb14c4ebfb7ae87b18"},
        }
        local sevenZip = find_tool("7z")
        if not sevenZip then raise("pideck-qt requires 7z to extract the official Qt archives") end

        local qtRoot = path.join(package:installdir(), "qt")
        local downloadRoot = path.join(package:builddir(), "qt-archives")
        os.mkdir(qtRoot)
        os.mkdir(downloadRoot)

        for _, item in ipairs(archives) do
            local archiveUrl = item.directory .. item.name
            local checksumFile = path.join(downloadRoot, item.name .. ".sha1")
            local archiveFile = path.join(downloadRoot, item.name)
            download.main(archiveUrl .. ".sha1", checksumFile)
            local official = io.readfile(checksumFile):match("^%s*([0-9a-fA-F]+)")
            if not official or official:lower() ~= item.sha1 then
                raise("Qt archive official checksum changed: " .. item.name)
            end
            download.main(archiveUrl, archiveFile)
            if hash.sha1(archiveFile):lower() ~= item.sha1 then
                raise("Qt archive checksum mismatch: " .. item.name)
            end
            os.vrunv(sevenZip.program, {"x", "-y", "-o" .. qtRoot, archiveFile})
        end

        if not os.isfile(path.join(qtRoot, "bin", "windeployqt.exe")) then
            raise("Qt SDK installation did not produce windeployqt.exe")
        end
        if not os.isfile(path.join(qtRoot, "include", "QtWebView", "qwebview.h")) then
            raise("Qt SDK installation did not produce QtWebView headers")
        end
        if not os.isfile(path.join(qtRoot, "lib", "Qt6WebView.lib")) then
            raise("Qt SDK installation did not produce the Qt6WebView library")
        end
    end)

    on_load(function (package)
        local root = package:installdir("qt")
        package:add("includedirs", "qt/include")
        for _, module in ipairs({"QtCore", "QtGui", "QtWidgets", "QtNetwork", "QtWebView"}) do
            package:add("includedirs", "qt/include/" .. module)
        end
        package:add("linkdirs", "qt/lib")
        package:add("links", "Qt6WebView", "Qt6Widgets", "Qt6Network", "Qt6Gui", "Qt6Core")
        if package:is_plat("windows") then
            package:add("links", "Qt6EntryPoint")
            package:add("syslinks", "user32", "shell32", "ole32", "advapi32", "runtimeobject", "windowsapp")
        end
        package:addenv("PATH", path.join(root, "bin"))
        package:set("qtroot", root)
    end)
