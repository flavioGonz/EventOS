# Regenera toda la superficie ISAPI desde los PDFs oficiales de isapi/.
#   make all        pipeline completo        make validate   valida los specs
#   make clean      borra intermedios
PDFDIR ?= ..
XLSXDIR ?= ../ISAPI_DVR_Pro Series With AcuSense/ISAPI_DVR_Pro Series With AcuSense
OUT      = ../.build
SPEC     = ../openapi
FAMS     = ipc-value deepinview anpr dvr-pro dvr-value

all: catalog

refs:
	python3 build_refs.py "$(XLSXDIR)" $(OUT) $(SPEC)/common

extract:
	@mkdir -p $(OUT)/raw
	python3 extract.py "$(PDFDIR)/ISAPI_Network Cameras_Value Series/ISAPI_Network Cameras_Value Series/ISAPI_Network Cameras_Value Series.pdf" $(OUT)/raw/ipc-value.json
	python3 extract.py "$(PDFDIR)/ISAPI_Network Cameras_DeepinView Series.pdf" $(OUT)/raw/deepinview.json
	python3 extract.py "$(PDFDIR)/ISAPI_Vehicle Access Control Management_ANPR Cameras.pdf" $(OUT)/raw/anpr.json
	python3 extract.py "$(PDFDIR)/ISAPI_DVR_Pro Series With AcuSense/ISAPI_DVR_Pro Series With AcuSense/ISAPI_DVR_Pro Series With AcuSense.pdf" $(OUT)/raw/dvr-pro.json
	python3 extract.py "$(PDFDIR)/ISAPI_DVR_Value Series/ISAPI_DVR_Value Series/ISAPI_DVR_Value Series.pdf" $(OUT)/raw/dvr-value.json

parse: extract
	@for f in $(FAMS); do python3 parse.py $(OUT)/raw/$$f.json $(OUT)/$$f.parsed.json; done

openapi: refs parse
	python3 build_openapi.py $(SPEC) $(OUT)

catalog: openapi
	HIK_BUILD=$(OUT) python3 supplement.py
	python3 build_catalog.py $(SPEC) $(SPEC) $(OUT)

validate:
	@python3 -c "import json,sys;from openapi_spec_validator import validate;\
[(validate(json.load(open(f'$(OUT)/{k}.json'))), print(k,'VALID')) for k in '$(FAMS)'.split()]"

clean:
	rm -rf $(OUT)

.PHONY: all refs extract parse openapi catalog validate clean
