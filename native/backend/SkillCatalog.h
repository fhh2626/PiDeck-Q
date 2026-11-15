#pragma once

#include <QJsonObject>
#include <QString>

struct SkillCatalogRead {
    bool ok = false;
    QJsonObject result;
    QString error;
};

SkillCatalogRead listSkills(const QString &skillsDir, const QString &sourceId, const QString &sourceLabel);
SkillCatalogRead createSkillDirectory(const QString &skillsDir, const QString &name, const QString &description);
SkillCatalogRead deleteSkillDirectory(const QString &skillsDir, const QString &name);
