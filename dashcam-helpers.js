/**
 * Tesla Dashcam Helpers
 * Protobuf initialization, field formatting, and CSV export utilities.
 */

// -------------------------------------------------------------
// Protobuf Initialization
// -------------------------------------------------------------

let SeiMetadata = null;
let enumFields = null;

/** Initialize protobuf by loading the .proto file */
async function initProtobuf(protoPath = 'dashcam.proto') {
    if (SeiMetadata) return { SeiMetadata, enumFields };

    const response = await fetch(protoPath);
    const root = protobuf.parse(await response.text()).root;
    SeiMetadata = root.lookupType('SeiMetadata');
    enumFields = {
        gearState: SeiMetadata.lookup('Gear'),
        autopilotState: SeiMetadata.lookup('AutopilotState'),
        gear_state: SeiMetadata.lookup('Gear'),
        autopilot_state: SeiMetadata.lookup('AutopilotState')
    };
    return { SeiMetadata, enumFields };
}

function getProtobuf() {
    return SeiMetadata ? { SeiMetadata, enumFields } : null;
}

// -------------------------------------------------------------
// Field Info & Formatting
// -------------------------------------------------------------

/** Derive field metadata from SeiMetadata type */
function deriveFieldInfo(SeiMetadataCtor, enumMap, options = {}) {
    return SeiMetadataCtor.fieldsArray.map(field => {
        const propName = field.name;
        const snakeName = propName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
        const label = propName
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .replace(/^./, s => s.toUpperCase())
            .replace(/Mps$/, '(m/s)')
            .replace(/Deg$/, '(°)');

        return {
            propName,
            protoName: options.useSnakeCase ? snakeName : propName,
            label: options.useLabels ? label : undefined,
            enumMap: enumMap[propName] || enumMap[snakeName] || null
        };
    });
}

/** Format a value for display */
function formatValue(value, enumType) {
    if (enumType) {
        const name = enumType.valuesById?.[value];
        if (name) return name;
        const entry = Object.entries(enumType).find(([, v]) => v === value);
        if (entry) return entry[0];
    }
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') return Number.isInteger(value) ? value : value.toFixed(2);
    if (typeof value === 'object' && value?.toString) return value.toString();
    return value;
}

// -------------------------------------------------------------
// CSV Export
// -------------------------------------------------------------

/** Build CSV from SEI messages */
function buildCsv(messages, fieldInfo) {
    const headers = fieldInfo.map(f => f.protoName || f.propName);
    const lines = [headers.join(',')];

    for (const msg of messages) {
        const values = fieldInfo.map(({ propName, enumMap }) => {
            let val = msg[propName];
            if (val === undefined || val === null) return '';
            if (enumMap?.valuesById) val = enumMap.valuesById[val] ?? val;
            const text = String(val);
            return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
        });
        lines.push(values.join(','));
    }
    return lines.join('\n');
}

// -------------------------------------------------------------
// Exports
// -------------------------------------------------------------

window.DashcamHelpers = {
    initProtobuf,
    getProtobuf,
    deriveFieldInfo,
    formatValue,
    buildCsv
};
