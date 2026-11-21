"""Private verifier using the same sealed libgmsh C API; never remeshes."""
import ctypes as c
import json
import os
from pathlib import Path
import sys

runtime, directory = map(lambda value: Path(value).resolve(), sys.argv[1:3])
handle = os.add_dll_directory(str(runtime))
gmsh = c.CDLL(str(runtime / "libgmsh.dll"))
integer, size, real = c.c_int, c.c_size_t, c.c_double
ip, sp, dp = c.POINTER(integer), c.POINTER(size), c.POINTER(real)
error = integer()
gmsh.gmshFree.argtypes = [c.c_void_p]
gmsh.gmshInitialize.argtypes = [integer, c.POINTER(c.c_char_p), integer, integer, ip]
gmsh.gmshFinalize.argtypes = [ip]
gmsh.gmshOpen.argtypes = [c.c_char_p, ip]
gmsh.gmshOptionSetNumber.argtypes = [c.c_char_p, real, ip]
gmsh.gmshModelGetPhysicalGroups.argtypes = [c.POINTER(ip), sp, integer, ip]
gmsh.gmshModelGetPhysicalName.argtypes = [integer, integer, c.POINTER(c.c_char_p), ip]
gmsh.gmshModelGetEntitiesForPhysicalGroup.argtypes = [integer, integer, c.POINTER(ip), sp, ip]
gmsh.gmshModelGetAdjacencies.argtypes = [integer, integer, c.POINTER(ip), sp, c.POINTER(ip), sp, ip]
gmsh.gmshModelMeshGetNodes.argtypes = [c.POINTER(sp), sp, c.POINTER(dp), sp, c.POINTER(dp), sp, integer, integer, integer, integer, ip]
gmsh.gmshModelMeshGetElementsByType.argtypes = [integer, c.POINTER(sp), sp, c.POINTER(sp), sp, integer, size, size, ip]

def call(name, *args):
    error.value = 0
    getattr(gmsh, name)(*args, c.byref(error))
    assert error.value == 0, (name, error.value)

def elements(kind, tag):
    ids, nodes, ni, nn = sp(), sp(), size(), size()
    call("gmshModelMeshGetElementsByType", kind, c.byref(ids), c.byref(ni), c.byref(nodes), c.byref(nn), tag, 0, 1)
    try:
        corners = 3 if kind == 2 else 4
        assert nn.value == ni.value * corners
        return {int(ids[i]): tuple(int(nodes[i * corners + j]) for j in range(corners)) for i in range(ni.value)}
    finally:
        gmsh.gmshFree(ids)
        gmsh.gmshFree(nodes)

manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
mesh = json.loads((directory / "result.json").read_text(encoding="utf-8"))["mesh"]
index = json.loads((directory / "quality.json").read_text(encoding="utf-8"))
call("gmshInitialize", 0, None, 0, 0)
try:
    call("gmshOptionSetNumber", b"General.Terminal", 0)
    call("gmshOpen", str(directory / "mesh.msh").encode("utf-8"))
    tags, coords, params, nt, nc, np = sp(), dp(), dp(), size(), size(), size()
    call("gmshModelMeshGetNodes", c.byref(tags), c.byref(nt), c.byref(coords), c.byref(nc), c.byref(params), c.byref(np), -1, -1, 0, 0)
    try:
        assert nt.value == mesh["nodeCount"] and nc.value == nt.value * 3
        actual_nodes = {int(tags[i]): tuple(coords[i * 3 + j] for j in range(3)) for i in range(nt.value)}
        expected_nodes = {i // 3 + 1: tuple(index["positions"][i:i + 3]) for i in range(0, len(index["positions"]), 3)}
        assert actual_nodes == expected_nodes, "MSH changed node identity or coordinates"
    finally:
        for value in (tags, coords, params):
            gmsh.gmshFree(value)
    all_tetrahedra, tet_faces = {}, {}
    for cell in mesh["sourceInventory"]["cells"]:
        tag = cell["cellIndex"] + 1
        rows = elements(4, tag)
        wanted = {int(row["elementId"]): tuple(n + 1 for n in row["corners"]) for row in index["cells"] if row["volumeTag"] == tag}
        assert rows == wanted, "MSH dropped or changed a volume element"
        assert not set(all_tetrahedra) & set(rows)
        all_tetrahedra.update(rows)
        for tet in rows.values():
            for order in ((1, 2, 3), (0, 3, 2), (0, 1, 3), (0, 2, 1)):
                key = tuple(sorted(tet[i] for i in order))
                tet_faces.setdefault((tag, key), 0)
                tet_faces[(tag, key)] += 1
    assert len(all_tetrahedra) == mesh["quality"]["tetraCount"]
    tet_face_keys = {face for _, face in tet_faces}
    surface_elements, shared_triangles, embedded_triangles = set(), 0, 0
    for surface in mesh["boundaryMapping"]["surfaces"]:
        rows = elements(2, surface["surfaceTag"])
        assert len(rows) == surface["elementCount"] and not surface_elements & set(rows)
        surface_elements.update(rows)
        wanted_volumes = sorted(int(tag[6:]) for tag in surface["adjacentSolidIds"])
        embedded_volumes = sorted(int(tag[6:]) for tag in surface.get("embeddedSolidIds", []))
        up, down, nu, nd = ip(), ip(), size(), size()
        call("gmshModelGetAdjacencies", 2, surface["surfaceTag"], c.byref(up), c.byref(nu), c.byref(down), c.byref(nd))
        try:
            assert sorted(up[i] for i in range(nu.value)) == wanted_volumes, "MSH changed surface adjacency"
        finally:
            gmsh.gmshFree(up)
            gmsh.gmshFree(down)
        for triangle in rows.values():
            key = tuple(sorted(triangle))
            for tag in wanted_volumes:
                assert tet_faces[(tag, key)] == 1, "MSH interface is not the exact boundary of each adjacent volume"
            for tag in embedded_volumes:
                assert tet_faces.get((tag, key)) == 2, "MSH embedded surface is not an actual two-sided tetrahedron face"
            if not wanted_volumes and not embedded_volumes:
                assert key not in tet_face_keys, "MSH exterior Sheet acquired a fictitious tetrahedron owner"
            if len(wanted_volumes) > 1:
                shared_triangles += 1
            if embedded_volumes:
                embedded_triangles += 1
    assert len(surface_elements) + len(all_tetrahedra) == mesh["elementCount"]
    assert not surface_elements & set(all_tetrahedra)
    groups, ng = ip(), size()
    call("gmshModelGetPhysicalGroups", c.byref(groups), c.byref(ng), -1)
    try:
        actual = {(groups[i], groups[i + 1]) for i in range(0, ng.value, 2)}
    finally:
        gmsh.gmshFree(groups)
    expected_groups = mesh["exportMapping"]["physicalGroups"]
    assert actual == {(row["dimension"], row["tag"]) for row in expected_groups}
    for row in expected_groups:
        dim, tag = row["dimension"], row["tag"]
        name, entities, count = c.c_char_p(), ip(), size()
        call("gmshModelGetPhysicalName", dim, tag, c.byref(name))
        call("gmshModelGetEntitiesForPhysicalGroup", dim, tag, c.byref(entities), c.byref(count))
        try:
            assert name.value.decode("utf-8") == row["name"]
            if dim == 2 and "cadFaceId" in row:
                expected = next(face["surfaceTags"] for face in mesh["boundaryMapping"]["sourceFaces"] if face["source"]["bodyId"] == row["bodyId"] and face["source"]["cadFaceId"] == row["cadFaceId"])
            elif dim == 2:
                sheet_faces = {(face["bodyId"], face["cadFaceId"]) for face in mesh["sourceInventory"]["sourceSheetFaces"]}
                expected = [surface["surfaceTag"] for surface in mesh["boundaryMapping"]["surfaces"] if any(source["bodyId"] == row["bodyId"] and (source["bodyId"], source["cadFaceId"]) in sheet_faces for source in surface["sources"])]
            else:
                indexes = {solid["sourceSolidIndex"] for solid in mesh["sourceInventory"]["sourceSolids"] if solid["bodyId"] == row["bodyId"] and ("sourceSolidId" not in row or solid["solidId"] == row["sourceSolidId"])}
                expected = [cell["cellIndex"] + 1 for cell in mesh["sourceInventory"]["cells"] if indexes & set(cell["sourceSolidIndexes"])]
            assert sorted(entities[i] for i in range(count.value)) == sorted(expected), "MSH lost multi-source membership"
        finally:
            gmsh.gmshFree(name)
            gmsh.gmshFree(entities)
    print(json.dumps({"ok": True, "nodes": len(actual_nodes), "tetrahedra": len(all_tetrahedra), "surfaceTriangles": len(surface_elements), "sharedTriangles": shared_triangles, "embeddedTriangles": embedded_triangles, "physicalGroups": len(expected_groups), "sourceMembershipVerified": True, "normalMeshAdmitted": manifest["normalMeshAdmitted"]}))
finally:
    call("gmshFinalize")
    handle.close()
