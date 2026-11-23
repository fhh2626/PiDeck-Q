#pragma once

#include <QJsonObject>
#include <QString>
#include <QStringList>

struct PromptCatalogRead {
    bool ok = false;
    QJsonObject result;
    QString error;
};

PromptCatalogRead listPromptTemplates(const QString &promptsDir, const QStringList &hiddenBuiltins);
PromptCatalogRead createPromptTemplate(const QString &promptsDir, const QString &name, const QString &content);
PromptCatalogRead deletePromptTemplate(const QString &promptsDir, const QString &name);
