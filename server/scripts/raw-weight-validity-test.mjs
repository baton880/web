import assert from 'node:assert/strict'
import {normalizeTelemetryPacket} from '../src/modules/telemetry/telemetry.routes.js'
assert.equal(normalizeTelemetryPacket({weight:100,raw:-9000,weight_valid:true}).weightValid,true)
assert.equal(normalizeTelemetryPacket({weight:100,raw:100,weight_valid:false}).weightValid,false)
assert.equal(normalizeTelemetryPacket({raw:100,weight_valid:true}).weightValid,false)
assert.equal(normalizeTelemetryPacket({weight:0,weight_valid:true}).weightValid,true)
console.log('PASS raw cannot invalidate packet weight; reported invalidity preserved')
