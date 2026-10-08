"""Read metadata through GDAL's stable API (also supported by Debian GDAL 3.6).

Only the ESRI Shapefile driver can open this local, already validated dataset.
This helper emits metadata, never feature attributes or database credentials.
"""

import json
import sys
from osgeo import gdal, ogr

gdal.UseExceptions()
ogr.UseExceptions()


def inspect(filename):
    dataset = gdal.OpenEx(
        filename,
        gdal.OF_VECTOR | gdal.OF_READONLY,
        allowed_drivers=["ESRI Shapefile"],
    )
    geometries = {
        ogr.wkbPoint: "Point",
        ogr.wkbMultiPoint: "MultiPoint",
        ogr.wkbLineString: "LineString",
        ogr.wkbMultiLineString: "MultiLineString",
        ogr.wkbPolygon: "Polygon",
        ogr.wkbMultiPolygon: "MultiPolygon",
    }
    layers = []
    for index in range(dataset.GetLayerCount()):
        layer = dataset.GetLayerByIndex(index)
        definition = layer.GetLayerDefn()
        fields = []
        for field_index in range(definition.GetGeomFieldCount()):
            field = definition.GetGeomFieldDefn(field_index)
            srs = field.GetSpatialRef()
            coordinate_system = None
            if srs is not None:
                try:
                    srs.AutoIdentifyEPSG()
                except RuntimeError:
                    pass  # A valid custom CRS need not have an EPSG identifier.
                authority = srs.GetAuthorityName(None)
                code = srs.GetAuthorityCode(None)
                coordinate_system = {
                    "wkt": srs.ExportToWkt(),
                    "projjson": {"id": {
                        "authority": authority,
                        "code": int(code) if code and code.isdigit() else None,
                    }},
                }
            fields.append({
                "type": geometries.get(ogr.GT_Flatten(field.GetType()), "Unsupported"),
                "coordinateSystem": coordinate_system,
            })
        layers.append({
            "featureCount": layer.GetFeatureCount(),
            "geometryFields": fields,
        })
    # GDAL 3.6 ogr2ogr has no -if option. Disable every other registered driver
    # when importing, while keeping the Shapefile reader and PostgreSQL writer.
    disabled = [gdal.GetDriver(i).ShortName for i in range(gdal.GetDriverCount())
                if gdal.GetDriver(i).ShortName not in ("ESRI Shapefile", "PostgreSQL")]
    return {"driverShortName": dataset.GetDriver().ShortName, "layers": layers,
            "disabledDrivers": disabled}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("Expected one dataset path")
        print(json.dumps(inspect(sys.argv[1])))
    except Exception:
        # Do not forward input paths or library diagnostics to the application.
        sys.stderr.write("Shapefile metadata inspection failed.\n")
        sys.exit(1)
