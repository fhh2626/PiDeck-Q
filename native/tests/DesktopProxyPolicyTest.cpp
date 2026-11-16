#include "DesktopProxy.h"

#include <QCoreApplication>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkProxyFactory>
#include <QNetworkProxyQuery>

#include <cstdio>

/** Exercise the production proxy factory without resolving hosts or opening sockets. */
int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    QFile input;
    if (!input.open(stdin, QIODevice::ReadOnly)) return 1;
    QJsonParseError error;
    const QJsonDocument document = QJsonDocument::fromJson(input.readAll(), &error);
    if (error.error != QJsonParseError::NoError || !document.isArray()) return 2;

    desktopproxy::installApplicationFactory();
    QJsonArray results;
    for (const QJsonValue &value : document.array()) {
        const QJsonObject fixture = value.toObject();
        const auto config = desktopproxy::apply(fixture.value(QStringLiteral("settings")).toObject());
        const QUrl target(fixture.value(QStringLiteral("url")).toString());
        const auto proxy = desktopproxy::proxyForUrl(target);
        const auto installed = QNetworkProxyFactory::proxyForQuery(QNetworkProxyQuery(target));
        results.append(QJsonObject{
            {QStringLiteral("bypassed"), desktopproxy::shouldBypass(target.host(), config)},
            {QStringLiteral("direct"), proxy.type() == QNetworkProxy::NoProxy},
            {QStringLiteral("factoryDirect"), installed.size() == 1
                && installed.first().type() == QNetworkProxy::NoProxy},
            {QStringLiteral("proxyHost"), proxy.hostName()},
            {QStringLiteral("proxyPort"), int(proxy.port())}
        });
    }
    const QByteArray output = QJsonDocument(results).toJson(QJsonDocument::Compact);
    std::fwrite(output.constData(), 1, size_t(output.size()), stdout);
    std::fputc('\n', stdout);
    return 0;
}
