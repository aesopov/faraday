cmake_minimum_required(VERSION 3.16)
project(faraday-helper C)

set(CMAKE_C_STANDARD 11)

add_executable(faraday-helper
    helper.c
    proto.c
    io.c
    ops.c
    watch.c
)

if(CMAKE_BUILD_TYPE STREQUAL "Release")
    set_target_properties(faraday-helper PROPERTIES
        C_VISIBILITY_PRESET hidden
    )
    if(NOT APPLE)
        target_link_options(faraday-helper PRIVATE -s)
    endif()
endif()
