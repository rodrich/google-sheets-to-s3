/**
 * @OnlyCurrentDoc
 */

/**
 * Adds add-on menu to Sheets UI.
 */
function createMenu() {
  SpreadsheetApp.getUi()
    .createAddonMenu() // when used as an Add-on
    // .createMenu("S3 JSON Publisher") // when directly added to Sheet
    .addItem("Configure...", "showConfig")
    .addItem("Publish Now", "publish")
    .addToUi();
}

/**
 * Adds menu on install.
 */
function onInstall() {
  createMenu();
}

/**
 * Adds menu on open.
 */
function onOpen() {
  createMenu();
}

/**
 * Returns an array containing the values from the top row of the data sheet.
 *
 * @return {string[]} array of column headers
 */
function getPopulatedColumnHeaders() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
}

/**
 * Publish updated JSON to S3 if changes were made to the first sheet event
 * object passed if called from trigger.
 *
 * @param {Object} event - event that triggered the function call
 */
function publish(event) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheetId = sheet.getId();
  var props = PropertiesService.getDocumentProperties().getProperties();
  var trackChanges = (props.trackChanges == "track");
  var dateColumn = props.updatedAt;

  // do nothing if required configuration settings are not present
  if (!hasRequiredProps()) {
    Logger.log("Did not publish. Spreadsheet [" + sheetId
      + "] does not have required props set");
    return;
  }

  // do nothing if the edited sheet is not the first one -- sheets are indexed
  // from 1 instead of 0
  if (sheet.getActiveSheet().getIndex() > 1) {
    Logger.log("Did not publish. Spreadsheet [" + sheetId
      + "] first sheet was not modified.");
    return;
  }

  // determine if last published date should be checked
  var checkDate = (trackChanges && dateColumn !== undefined);

  // get cell values from the range that contains data (2D array)
  var rows = sheet
    .getDataRange()
    .getValues();

  // filter out empty rows and if tracking changes, filter to only those
  // modified since last publish, then exclude columns that don't have a header
  // (i.e. text in row 1)
  var lastPublished = new Date(props.lastPublished);
  rows = rows
    .filter(function(row, index) {
      return row.some(function(value) {
        return typeof value !== "string" || value.length;
      }) && (index == 0 || !checkDate
        || (checkDate && (new Date(row[dateColumn]) > lastPublished)));
    })
    .map(function(row) {
      return row.filter(function(value, index) {
        return rows[0][index].length;
      });
    });

  // create an array of objects keyed by header
  var objs = rows
    .slice(1)
    .map(function(row) {
      var obj = {};
      row.forEach(function(value, index) {
        var prop = rows[0][index];
        // represent blank cell values as `null`
        // blank cells always appear as an empty string regardless of the data
        // type of other values in the column. neutralizing everything to `null`
        // lets us avoid mixing empty strings with other data types for a prop.
        obj[prop] = (typeof value === "string" && !value.length) ? null : value;
      });
      return obj;
    });

  // wrap array in object
  var content = {
    data: objs
  }

  // add date of last publish if tracking changes
  if (trackChanges) {
    content["recordsSince"] = lastPublished;
  }

  // upload to S3
  // https://github.com/viuinsight/google-apps-script-for-aws
  try {
    // build object key based on whether changes should be tracked or not
    var objectKey = (props.path ? props.path + "/" : "") + sheetId
      + (trackChanges
        ? Utilities.formatDate(new Date(), "GMT", "-yyyy-MM-dd'T'HH-mm-ss-SSS")
        : "")
      + ".json";
    AWS.S3.init(props.awsAccessKeyId, props.awsSecretKey);
    AWS.S3.putObject(props.bucketName, objectKey, content, props.region);
    Logger.log("Published Spreadsheet to [" + objectKey + "]");
    PropertiesService.getDocumentProperties().setProperties({
      lastPublished: new Date()
    });
  } catch (e) {
    Logger.log("Did not publish. Spreadsheet [" + sheetId
      + "] generated following AWS error.\n" + e.toString());
  }
}

/**
 * Displays the configuration modal dialog.
 */
function showConfig() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getDocumentProperties().getProperties();
  var template = HtmlService.createTemplateFromFile("config");
  template.sheetId = sheet.getId();
  template.bucketName = props.bucketName || "";
  template.region = props.region || "";
  template.path = props.path || "";
  template.awsAccessKeyId = props.awsAccessKeyId || "";
  template.awsSecretKey = props.awsSecretKey || "";
  template.trackChanges = props.trackChanges || "";
  template.updatedAt = props.updatedAt || "";
  ui.showModalDialog(template.evaluate(), "Amazon S3 Publish Configuration");
}

/**
 * Submit action for the configuration modal dialog.
 *
 * @param {form} form - Web form that triggered the submit.
 */
function updateConfig(form) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheetId = sheet.getId();
  var newProps = {
    bucketName: form.bucketName,
    region: form.region,
    path: form.path,
    awsAccessKeyId: form.awsAccessKeyId,
    awsSecretKey: form.awsSecretKey,
    trackChanges: form.trackChanges
  };
  if (form.trackChanges) {
    newProps["trackChanges"] = form.updatedAt;
  } else {
    newProps["lastPublished"] = undefined;
    newProps["trackChanges"] = undefined;
  }
  PropertiesService.getDocumentProperties().setProperties(newProps);

  // Assume update will fail
  var title = "Configuration failed to update";
  var message;
  if (hasRequiredProps()) {
    title = "✓ Configuration updated";
    message = "Published spreadsheet will be accessible at: \nhttps://"
      + form.bucketName + ".s3.amazonaws.com/" + form.path + "/" + sheet.getId()
      + (form.trackChanges ? "-<yyyy-MM-dd>T<HH-mm-ss-SSS>" : "") + ".json";
    publish();
    // Create an onChange trigger programatically instead of manually because
    // manual triggers disappear for no reason. See:
    // https://code.google.com/p/google-apps-script-issues/issues/detail?id=4854
    // https://code.google.com/p/google-apps-script-issues/issues/detail?id=5831
    // Deleting previous copies with the same name for this spreadsheet first.
    try {
      var fnName = "publish";

      var triggers = ScriptApp.getProjectTriggers();
      for (var i = 0; i < triggers.length; i++) {
        var triggerFunction = triggers[i].getHandlerFunction();
        var triggerSource = triggers[i].getTriggerSourceId();
        if (triggerSource === sheetId && triggerFunction === fnName) {
          ScriptApp.deleteTrigger(triggers[i]);
        }
      }

      ScriptApp.newTrigger(fnName)
        .forSpreadsheet(sheet)
        .onChange()
        .create();
    } catch (e) {
      message = "Could not register event listener.\n" + e.toString();
      Logger.log("Could not register onChange event for Spreadsheet [" + sheetId
        + "]\n" + e.toString());
    }
  } else {
    message = "You will need to fill out all configuration options for your "
      + "spreadsheet to be published to S3.";
  }
  var ui = SpreadsheetApp.getUi();
  ui.alert(title, message, ui.ButtonSet.OK);
}

/**
 * Checks if the Sheet has the required configuration settings to publish to S3.
 * Does not validate the values, only ensures they are not empty.
 *
 * @return {boolean} true if all required properties are set, false otherwise.
 */
function hasRequiredProps() {
  var props = PropertiesService.getDocumentProperties().getProperties();
  return props.bucketName && props.region && props.awsAccessKeyId
    && props.awsSecretKey;
}
