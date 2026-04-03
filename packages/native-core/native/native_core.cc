#include <node_api.h>

#include <cstddef>

#include "collision_core.h"

using avara::native_core::FindRayDistance;
using avara::native_core::FindSegmentImpact;
using avara::native_core::SegmentImpact;
using avara::native_core::Vec3;

namespace {

bool ReadDouble(napi_env env, napi_value value, double *out) {
    return napi_get_value_double(env, value, out) == napi_ok;
}

bool ReadTypedArray(napi_env env, napi_value value, double **data, std::size_t *triangleCount) {
    napi_typedarray_type typedArrayType;
    std::size_t length = 0;
    void *rawData = nullptr;
    napi_value arrayBuffer;
    std::size_t byteOffset = 0;

    if (napi_get_typedarray_info(env, value, &typedArrayType, &length, &rawData, &arrayBuffer, &byteOffset) != napi_ok) {
      return false;
    }

    if (typedArrayType != napi_float64_array || length % 9 != 0) {
      return false;
    }

    *data = static_cast<double *>(rawData);
    *triangleCount = length / 9;
    return true;
}

napi_value CreateNull(napi_env env) {
    napi_value result;
    napi_get_null(env, &result);
    return result;
}

napi_value CreateSegmentImpactResult(napi_env env, const SegmentImpact &impact) {
    if (!impact.hit) {
        return CreateNull(env);
    }

    napi_value result;
    napi_create_object(env, &result);

    napi_value tValue;
    napi_create_double(env, impact.t, &tValue);
    napi_set_named_property(env, result, "t", tValue);

    napi_value xValue;
    napi_create_double(env, impact.point.x, &xValue);
    napi_set_named_property(env, result, "x", xValue);

    napi_value yValue;
    napi_create_double(env, impact.point.y, &yValue);
    napi_set_named_property(env, result, "y", yValue);

    napi_value zValue;
    napi_create_double(env, impact.point.z, &zValue);
    napi_set_named_property(env, result, "z", zValue);

    return result;
}

napi_value FindSegmentImpactWrapped(napi_env env, napi_callback_info info) {
    std::size_t argc = 8;
    napi_value argv[8];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 8) {
        return CreateNull(env);
    }

    double *triangles = nullptr;
    std::size_t triangleCount = 0;
    if (!ReadTypedArray(env, argv[0], &triangles, &triangleCount)) {
        return CreateNull(env);
    }

    Vec3 start{};
    Vec3 end{};
    double radius = 0.0;
    if (!ReadDouble(env, argv[1], &start.x) ||
        !ReadDouble(env, argv[2], &start.y) ||
        !ReadDouble(env, argv[3], &start.z) ||
        !ReadDouble(env, argv[4], &end.x) ||
        !ReadDouble(env, argv[5], &end.y) ||
        !ReadDouble(env, argv[6], &end.z) ||
        !ReadDouble(env, argv[7], &radius)) {
        return CreateNull(env);
    }

    return CreateSegmentImpactResult(env, FindSegmentImpact(triangles, triangleCount, start, end, radius));
}

napi_value FindRayDistanceWrapped(napi_env env, napi_callback_info info) {
    std::size_t argc = 7;
    napi_value argv[7];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 7) {
        return CreateNull(env);
    }

    double *triangles = nullptr;
    std::size_t triangleCount = 0;
    if (!ReadTypedArray(env, argv[0], &triangles, &triangleCount)) {
        return CreateNull(env);
    }

    Vec3 origin{};
    Vec3 target{};
    if (!ReadDouble(env, argv[1], &origin.x) ||
        !ReadDouble(env, argv[2], &origin.y) ||
        !ReadDouble(env, argv[3], &origin.z) ||
        !ReadDouble(env, argv[4], &target.x) ||
        !ReadDouble(env, argv[5], &target.y) ||
        !ReadDouble(env, argv[6], &target.z)) {
        return CreateNull(env);
    }

    double distance = 0.0;
    if (!FindRayDistance(triangles, triangleCount, origin, target, &distance)) {
        return CreateNull(env);
    }

    napi_value result;
    napi_create_double(env, distance, &result);
    return result;
}

} // namespace

NAPI_MODULE_INIT() {
    napi_value findSegmentImpact;
    napi_create_function(env, "findSegmentImpact", NAPI_AUTO_LENGTH, FindSegmentImpactWrapped, nullptr, &findSegmentImpact);
    napi_set_named_property(env, exports, "findSegmentImpact", findSegmentImpact);

    napi_value findRayDistance;
    napi_create_function(env, "findRayDistance", NAPI_AUTO_LENGTH, FindRayDistanceWrapped, nullptr, &findRayDistance);
    napi_set_named_property(env, exports, "findRayDistance", findRayDistance);

    return exports;
}
