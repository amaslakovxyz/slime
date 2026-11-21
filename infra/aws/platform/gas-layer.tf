# Gas: the Slime engine as a Lambda layer, shared by every provisioned endpoint.
#
#   layer  slime-gas   <- slime-cloud/runtime/dist/layer (build.sh), extracts to /opt/slime/
#   shim   index.mjs   <- slime-cloud/provisioner/shim: re-exports /opt/slime/index.js
#
# Each endpoint function is the shim plus the layer version that was current
# when it was provisioned; a new layer version reaches new endpoints only.

data "archive_file" "gas_layer" {
  type             = "zip"
  source_dir       = "${path.module}/../../../slime-cloud/runtime/dist/layer"
  output_path      = "${path.module}/.build/gas-layer.zip"
  output_file_mode = "0644" # stable hash across machines
}

resource "aws_lambda_layer_version" "gas" {
  layer_name               = "${var.project}-gas"
  description              = "Slime engine (Gas/Liquid/Crystal) for provisioned endpoints"
  filename                 = data.archive_file.gas_layer.output_path
  source_code_hash         = data.archive_file.gas_layer.output_base64sha256
  compatible_runtimes      = ["nodejs22.x"]
  compatible_architectures = ["arm64"]
  # Endpoints stay on the version they were created with; deleting it on the
  # next build would break any later config update of those functions.
  skip_destroy = true
}

data "archive_file" "endpoint_shim" {
  type             = "zip"
  source_file      = "${path.module}/../../../slime-cloud/provisioner/shim/index.mjs"
  output_path      = "${path.module}/.build/endpoint-shim.zip"
  output_file_mode = "0644"
}
