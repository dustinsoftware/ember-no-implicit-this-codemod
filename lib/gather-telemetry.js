const puppeteer = require('puppeteer');
const cache = require('./cache');

module.exports = async function gatherTelemetry(url) {
  let page;
  let browser;

  try {
    browser = await puppeteer.launch({ ignoreHTTPSErrors: true, devtools: true });
    page = await browser.newPage();

    await page.goto(url);

    await page.exposeFunction('logErrorInNodeProcess', message => {
      console.error(message); // eslint-disable-line no-console
    });
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  } catch (e) {
    console.error('Failed to visit Ember App');
    console.error(e);
    process.exit(1);
  }

  let telemetry;

  try {
    telemetry = await buildTelemetry(page);
  } catch (e) {
    console.error('Failed to build telemetry');
    console.error(e);
    process.exit(1);
  }

  cache.set('telemetry', JSON.stringify(telemetry));

  await browser.close();

  console.log(telemetry);
  console.log('finished gathering telemetry');
};

async function buildTelemetry(page) {
  // Get the "viewport" of the page, as reported by the page.
  //
  // NOTE: nothing inside of evaluate can call to anything
  //       outside of the evaluate closure.
  const telemetry = await page.evaluate(() => {
    function evaluatePage() {
      /**
       * Compares the object with types of Ember objects
       *
       * @param {Object} object
       * @returns {String} type
       */
      function getType(object) {
        const types = [
          'Application',
          'Controller',
          'Helper',
          'Route',
          'Component',
          'Service',
          'Router',
          'Engine',
        ];
        return types.find(type => Ember[type] && object instanceof Ember[type]) || 'EmberObject';
      }

      /**
       * Parses ember meta data object and collects the runtime information
       *
       * @param {Object} meta
       *
       * @returns {Object} data - Parsed metadata for the ember object
       * @returns {String[]} data.computedProperties - list of computed properties
       * @returns {String[]} data.observedProperties - list of observed properties
       * @returns {Object} data.observerProperties - list of observer properties
       * @returns {Object} data.offProperties - list of observer properties
       * @returns {String[]} data.overriddenActions - list of overridden actions
       * @returns {String[]} data.overriddenProperties - list of overridden properties
       * @returns {String[]} data.ownProperties - list of object's own properties
       * @returns {String} data.type - type of ember object
       * @returns {Object} data.unobservedProperties - list of unobserved properties
       */
      function parseMeta(meta = {}) {
        if (!meta || !meta.source) {
          return {};
        }
        const { source } = meta;
        const type = getType(source);

        const ownProperties = Object.keys(source).filter(
          key => !['_super', 'actions'].includes(key)
        );

        const ownActions = source.actions ? Object.keys(source.actions) : [];

        const computedProperties = [];
        meta.forEachDescriptors((name, desc) => {
          const descProto = Object.getPrototypeOf(desc) || {};
          const constructorName = descProto.constructor ? descProto.constructor.name : '';

          if (
            desc.enumerable &&
            ownProperties.includes(name) &&
            constructorName === 'ComputedProperty'
          ) {
            computedProperties.push(name);
          }
        });

        return {
          computedProperties,
          ownActions,
          ownProperties,
          type,
        };
      }

      const SKIPPED_MODULES = [
        'fetch/ajax',
        'ember-percy',
        'ember-percy/index',
        'ember-percy/finalize',
        'ember-percy/snapshot',
      ];

      /* globals window, Ember */
      let telemetry = {};

      const modules = Object.keys(window.require.entries);

      for (let modulePath of modules) {
        if (SKIPPED_MODULES.includes(modulePath)) {
          continue;
        }

        try {
          let module = require(modulePath);

          if (module && module.default && module.default.proto) {
            let defaultProto = module.default.proto();
            let meta = parseMeta(Ember.meta(defaultProto));

            telemetry[modulePath] = meta;
          }
        } catch (error) {
          // log the error, but continue
          window.logErrorInNodeProcess(`error evaluating \`${modulePath}\`: ${error.message}`);
        }
      }

      return telemetry;
    }

    return evaluatePage();
  });

  return telemetry;
}
