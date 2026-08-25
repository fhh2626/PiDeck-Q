#pragma once

#include <QString>

class ProtocolRegistrar final {
public:
    static bool registerProtocol(const QString &executablePath);
};
