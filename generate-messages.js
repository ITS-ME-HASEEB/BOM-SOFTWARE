// generate-messages.js — regenerate the NSIS language message includes that
// electron-builder wrote to a temp dir (now deleted).
'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const langs = require('app-builder-lib/out/util/langs');
const { LangConfigurator } = require('app-builder-lib/out/targets/nsis/nsisLang');

const templatesDir = path.join(__dirname, 'node_modules/app-builder-lib/templates/nsis');

function computeCustomMessageTranslations(messages, langConfigurator) {
  const result = [];
  const includedLangs = new Set(langConfigurator.langs);
  for (const messageId of Object.keys(messages)) {
    const langToTranslations = messages[messageId];
    const unspecifiedLangs = new Set(langConfigurator.langs);
    for (const lang of Object.keys(langToTranslations)) {
      const langWithRegion = langs.toLangWithRegion(lang);
      if (!includedLangs.has(langWithRegion)) continue;
      const value = langToTranslations[lang];
      if (value == null) throw new Error(`${messageId} not specified for ${lang}`);
      result.push(`LangString ${messageId} ${langs.lcid[langWithRegion]} "${value.replace(/\n/g, '$\\r$\\n')}"`);
      unspecifiedLangs.delete(langWithRegion);
    }
    if (langConfigurator.isMultiLang) {
      const defaultTranslation = langToTranslations.en.replace(/\n/g, '$\\r$\\n');
      for (const langWithRegion of unspecifiedLangs) {
        result.push(`LangString ${messageId} ${langs.lcid[langWithRegion]} "${defaultTranslation}"`);
      }
    }
  }
  return result;
}

const langConfigurator = new LangConfigurator({ unicode: true, multiLanguageInstaller: true, installerLanguages: undefined });

[['messages.yml', 'release/0-messages.nsh'], ['assistedMessages.yml', 'release/1-messages.nsh']].forEach(([input, output]) => {
  const data = yaml.load(fs.readFileSync(path.join(templatesDir, input), 'utf8'));
  const instructions = computeCustomMessageTranslations(data, langConfigurator).join('\n');
  fs.writeFileSync(path.join(__dirname, output), instructions + '\n');
  console.log(output, '->', instructions.split('\n').length, 'lines');
});
