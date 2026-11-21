#!/bin/bash
# slime-admin Lambda handler: AWS Lambda Web Adapter (AWS_LAMBDA_EXEC_WRAPPER=/opt/bootstrap)
# runs this script and proxies invocations to the HTTP server it starts on $PORT.
exec node start.mjs
