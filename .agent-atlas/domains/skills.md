# Domain: skills

**Directory:** `src/skills`
**Files:** 56
**Symbols:** 398

## Files

### `skills/docx/scripts/__init__.py`

_No exported symbols detected._

### `skills/docx/scripts/accept_changes.py`

**Functions:**
- `accept_changes` (line 36)
- `_setup_libreoffice_macro` (line 91)

**Variables:**
- `LIBREOFFICE_PROFILE` (line 16)
- `MACRO_DIR` (line 17)
- `ACCEPT_CHANGES_MACRO` (line 19)


### `skills/docx/scripts/comment.py`

**Functions:**
- `_generate_hex_id` (line 68)
- `_encode_smart_quotes` (line 80)
- `_append_xml` (line 86)
- `_find_para_id` (line 98)
- `_get_next_rid` (line 108)
- `_has_relationship` (line 121)
- `_has_content_type` (line 129)
- `_ensure_comment_relationships` (line 137)
- `_ensure_comment_content_types` (line 179)
- `add_comment` (line 218)

**Variables:**
- `TEMPLATE_DIR` (line 25)
- `NS` (line 26)
- `COMMENT_XML` (line 34)
- `COMMENT_MARKER_TEMPLATE` (line 52)
- `REPLY_MARKER_TEMPLATE` (line 59)
- `SMART_QUOTE_ENTITIES` (line 72)


### `skills/docx/scripts/office/helpers/__init__.py`

_No exported symbols detected._

### `skills/docx/scripts/office/helpers/merge_runs.py`

**Functions:**
- `merge_runs` (line 16)
- `_find_elements` (line 44)
- `_get_child` (line 59)
- `_get_children` (line 68)
- `_is_adjacent` (line 78)
- `_remove_elements` (line 93)
- `_strip_run_rsid_attrs` (line 99)
- `_merge_runs_in` (line 108)
- `_first_child_run` (line 128)
- `_next_element_sibling` (line 135)
- `_next_sibling_run` (line 144)
- `_is_run` (line 154)
- `_can_merge` (line 159)
- `_merge_run_content` (line 170)
- `_consolidate_text` (line 178)

**Methods:**
- `traverse` (line 47)


### `skills/docx/scripts/office/helpers/simplify_redlines.py`

**Functions:**
- `simplify_redlines` (line 22)
- `_merge_tracked_changes_in` (line 47)
- `_is_element` (line 75)
- `_get_author` (line 80)
- `_can_merge_tracked` (line 89)
- `_merge_tracked_content` (line 104)
- `_find_elements` (line 111)
- `get_tracked_change_authors` (line 126)
- `_get_authors_from_docx` (line 149)
- `infer_author` (line 172)

**Methods:**
- `traverse` (line 114)

**Variables:**
- `WORD_NS` (line 19)


### `skills/docx/scripts/office/pack.py`

**Functions:**
- `pack` (line 24)
- `_run_validation` (line 69)
- `_condense_xml` (line 108)


### `skills/docx/scripts/office/soffice.py`

**Functions:**
- `get_soffice_env` (line 24)
- `run_soffice` (line 35)
- `_needs_shim` (line 44)
- `_ensure_shim` (line 53)


### `skills/docx/scripts/office/unpack.py`

**Functions:**
- `unpack` (line 34)
- `_pretty_print_xml` (line 82)
- `_escape_smart_quotes` (line 91)

**Variables:**
- `SMART_QUOTE_REPLACEMENTS` (line 26)


### `skills/docx/scripts/office/validate.py`

**Functions:**
- `main` (line 25)


### `skills/docx/scripts/office/validators/__init__.py`

_No exported symbols detected._

### `skills/docx/scripts/office/validators/base.py`

**Classes:**
- `BaseSchemaValidator` (line 12)

**Methods:**
- `__init__` (line 94)
- `validate` (line 109)
- `repair` (line 112)
- `repair_whitespace_preservation` (line 115)
- `validate_xml` (line 143)
- `validate_namespaces` (line 170)
- `validate_unique_ids` (line 199)
- `validate_file_references` (line 289)
- `validate_all_relationship_ids` (line 385)
- `_get_expected_relationship_type` (line 469)
- `validate_content_types` (line 492)
- `validate_file_against_xsd` (line 598)
- `validate_against_xsd` (line 636)
- `_get_schema_path` (line 685)
- `_clean_ignorable_namespaces` (line 703)
- `_remove_ignorable_elements` (line 723)
- `_preprocess_for_mc_ignorable` (line 742)
- `_validate_single_file_xsd` (line 750)
- `_get_original_file_errors` (line 787)
- `_remove_template_tags_from_text_nodes` (line 814)
- `process_text_content` (line 821)


### `skills/docx/scripts/office/validators/docx.py`

**Classes:**
- `DOCXSchemaValidator` (line 16)

**Methods:**
- `validate` (line 24)
- `validate_whitespace_preservation` (line 66)
- `validate_deletions` (line 112)
- `count_paragraphs_in_unpacked` (line 163)
- `count_paragraphs_in_original` (line 179)
- `validate_insertions` (line 202)
- `compare_paragraph_counts` (line 243)
- `_parse_id_value` (line 251)
- `validate_id_constraints` (line 254)
- `validate_comment_markers` (line 298)
- `repair` (line 386)
- `repair_durableId` (line 391)


### `skills/docx/scripts/office/validators/pptx.py`

**Classes:**
- `PPTXSchemaValidator` (line 10)

**Methods:**
- `validate` (line 25)
- `validate_uuid_ids` (line 62)
- `_looks_like_uuid` (line 100)
- `validate_slide_layout_ids` (line 104)
- `validate_no_duplicate_slide_layouts` (line 172)
- `validate_notes_slide_references` (line 210)


### `skills/docx/scripts/office/validators/redlining.py`

**Classes:**
- `RedliningValidator` (line 11)

**Methods:**
- `__init__` (line 13)
- `repair` (line 22)
- `validate` (line 25)
- `_generate_detailed_diff` (line 104)
- `_get_git_word_diff` (line 127)
- `_remove_author_tracked_changes` (line 198)
- `_extract_text_content` (line 229)


### `skills/pdf/scripts/check_bounding_boxes.py`

**Classes:**
- `RectAndField` (line 9)

**Functions:**
- `get_bounding_box_messages` (line 15)

**Methods:**
- `rects_intersect` (line 20)


### `skills/pdf/scripts/check_fillable_fields.py`

_No exported symbols detected._

### `skills/pdf/scripts/convert_pdf_to_images.py`

**Functions:**
- `convert` (line 9)


### `skills/pdf/scripts/create_validation_image.py`

**Functions:**
- `create_validation_image` (line 9)


### `skills/pdf/scripts/extract_form_field_info.py`

**Functions:**
- `get_full_annotation_field_id` (line 9)
- `make_field_dict` (line 19)
- `get_field_info` (line 47)
- `write_field_info` (line 110)

**Methods:**
- `sort_key` (line 96)


### `skills/pdf/scripts/extract_form_structure.py`

**Functions:**
- `extract_form_structure` (line 20)
- `main` (line 91)


### `skills/pdf/scripts/fill_fillable_fields.py`

**Functions:**
- `fill_pdf_fields` (line 11)
- `validation_error_for_field_value` (line 55)
- `monkeypatch_pydpf_method` (line 74)

**Methods:**
- `patched_get_inherited` (line 80)


### `skills/pdf/scripts/fill_pdf_form_with_annotations.py`

**Functions:**
- `transform_from_image_coords` (line 10)
- `transform_from_pdf_coords` (line 23)
- `fill_pdf_form` (line 33)


### `skills/pptx/scripts/__init__.py`

_No exported symbols detected._

### `skills/pptx/scripts/add_slide.py`

**Functions:**
- `get_next_slide_number` (line 27)
- `create_slide_from_layout` (line 33)
- `duplicate_slide` (line 90)
- `_add_to_content_types` (line 130)
- `_add_to_presentation_rels` (line 141)
- `_get_next_slide_id` (line 158)
- `parse_source` (line 165)


### `skills/pptx/scripts/clean.py`

**Functions:**
- `get_slides_in_sldidlst` (line 27)
- `remove_orphaned_slides` (line 49)
- `remove_trash_directory` (line 91)
- `get_slide_referenced_files` (line 106)
- `remove_orphaned_rels_files` (line 128)
- `get_referenced_files` (line 153)
- `remove_orphaned_files` (line 171)
- `update_content_types` (line 221)
- `clean_unused_files` (line 241)


### `skills/pptx/scripts/office/helpers/__init__.py`

_No exported symbols detected._

### `skills/pptx/scripts/office/helpers/merge_runs.py`

**Functions:**
- `merge_runs` (line 16)
- `_find_elements` (line 44)
- `_get_child` (line 59)
- `_get_children` (line 68)
- `_is_adjacent` (line 78)
- `_remove_elements` (line 93)
- `_strip_run_rsid_attrs` (line 99)
- `_merge_runs_in` (line 108)
- `_first_child_run` (line 128)
- `_next_element_sibling` (line 135)
- `_next_sibling_run` (line 144)
- `_is_run` (line 154)
- `_can_merge` (line 159)
- `_merge_run_content` (line 170)
- `_consolidate_text` (line 178)

**Methods:**
- `traverse` (line 47)


### `skills/pptx/scripts/office/helpers/simplify_redlines.py`

**Functions:**
- `simplify_redlines` (line 22)
- `_merge_tracked_changes_in` (line 47)
- `_is_element` (line 75)
- `_get_author` (line 80)
- `_can_merge_tracked` (line 89)
- `_merge_tracked_content` (line 104)
- `_find_elements` (line 111)
- `get_tracked_change_authors` (line 126)
- `_get_authors_from_docx` (line 149)
- `infer_author` (line 172)

**Methods:**
- `traverse` (line 114)

**Variables:**
- `WORD_NS` (line 19)


### `skills/pptx/scripts/office/pack.py`

**Functions:**
- `pack` (line 24)
- `_run_validation` (line 69)
- `_condense_xml` (line 108)


### `skills/pptx/scripts/office/soffice.py`

**Functions:**
- `get_soffice_env` (line 24)
- `run_soffice` (line 35)
- `_needs_shim` (line 44)
- `_ensure_shim` (line 53)


### `skills/pptx/scripts/office/unpack.py`

**Functions:**
- `unpack` (line 34)
- `_pretty_print_xml` (line 82)
- `_escape_smart_quotes` (line 91)

**Variables:**
- `SMART_QUOTE_REPLACEMENTS` (line 26)


### `skills/pptx/scripts/office/validate.py`

**Functions:**
- `main` (line 25)


### `skills/pptx/scripts/office/validators/__init__.py`

_No exported symbols detected._

### `skills/pptx/scripts/office/validators/base.py`

**Classes:**
- `BaseSchemaValidator` (line 12)

**Methods:**
- `__init__` (line 94)
- `validate` (line 109)
- `repair` (line 112)
- `repair_whitespace_preservation` (line 115)
- `validate_xml` (line 143)
- `validate_namespaces` (line 170)
- `validate_unique_ids` (line 199)
- `validate_file_references` (line 289)
- `validate_all_relationship_ids` (line 385)
- `_get_expected_relationship_type` (line 469)
- `validate_content_types` (line 492)
- `validate_file_against_xsd` (line 598)
- `validate_against_xsd` (line 636)
- `_get_schema_path` (line 685)
- `_clean_ignorable_namespaces` (line 703)
- `_remove_ignorable_elements` (line 723)
- `_preprocess_for_mc_ignorable` (line 742)
- `_validate_single_file_xsd` (line 750)
- `_get_original_file_errors` (line 787)
- `_remove_template_tags_from_text_nodes` (line 814)
- `process_text_content` (line 821)


### `skills/pptx/scripts/office/validators/docx.py`

**Classes:**
- `DOCXSchemaValidator` (line 16)

**Methods:**
- `validate` (line 24)
- `validate_whitespace_preservation` (line 66)
- `validate_deletions` (line 112)
- `count_paragraphs_in_unpacked` (line 163)
- `count_paragraphs_in_original` (line 179)
- `validate_insertions` (line 202)
- `compare_paragraph_counts` (line 243)
- `_parse_id_value` (line 251)
- `validate_id_constraints` (line 254)
- `validate_comment_markers` (line 298)
- `repair` (line 386)
- `repair_durableId` (line 391)


### `skills/pptx/scripts/office/validators/pptx.py`

**Classes:**
- `PPTXSchemaValidator` (line 10)

**Methods:**
- `validate` (line 25)
- `validate_uuid_ids` (line 62)
- `_looks_like_uuid` (line 100)
- `validate_slide_layout_ids` (line 104)
- `validate_no_duplicate_slide_layouts` (line 172)
- `validate_notes_slide_references` (line 210)


### `skills/pptx/scripts/office/validators/redlining.py`

**Classes:**
- `RedliningValidator` (line 11)

**Methods:**
- `__init__` (line 13)
- `repair` (line 22)
- `validate` (line 25)
- `_generate_detailed_diff` (line 104)
- `_get_git_word_diff` (line 127)
- `_remove_author_tracked_changes` (line 198)
- `_extract_text_content` (line 229)


### `skills/pptx/scripts/thumbnail.py`

**Functions:**
- `main` (line 40)
- `get_slide_info` (line 95)
- `build_slide_list` (line 121)
- `create_hidden_placeholder` (line 149)
- `convert_to_images` (line 158)
- `create_grids` (line 196)
- `create_grid` (line 225)

**Variables:**
- `THUMBNAIL_WIDTH` (line 29)
- `CONVERSION_DPI` (line 30)
- `MAX_COLS` (line 31)
- `DEFAULT_COLS` (line 32)
- `JPEG_QUALITY` (line 33)
- `GRID_PADDING` (line 34)
- `BORDER_WIDTH` (line 35)
- `FONT_SIZE_RATIO` (line 36)
- `LABEL_PADDING_RATIO` (line 37)


### `skills/screenshot/scripts/macos_display_info.swift`

**Classes:**
- `Response` (line 4)


### `skills/screenshot/scripts/macos_permissions.swift`

**Classes:**
- `Status` (line 4)

**Functions:**
- `screenCaptureGranted` (line 12)


### `skills/screenshot/scripts/macos_window_info.swift`

**Classes:**
- `Bounds` (line 5)
- `WindowInfo` (line 12)
- `Response` (line 21)

**Functions:**
- `value` (line 27)
- `rank` (line 95)


### `skills/screenshot/scripts/take_screenshot.py`

**Functions:**
- `parse_region` (line 33)
- `test_mode_enabled` (line 46)
- `normalize_platform` (line 51)
- `test_platform_override` (line 62)
- `parse_int_list` (line 69)
- `test_window_ids` (line 82)
- `test_display_ids` (line 88)
- `write_test_png` (line 94)
- `timestamp` (line 99)
- `default_filename` (line 103)
- `mac_default_dir` (line 107)
- `default_dir` (line 124)
- `ensure_parent` (line 145)
- `resolve_output_path` (line 153)
- `multi_output_paths` (line 180)
- `run` (line 191)
- `swift_json` (line 200)
- `macos_screen_capture_granted` (line 224)
- `ensure_macos_permissions` (line 230)
- `activate_app` (line 244)
- `macos_window_payload` (line 250)
- `macos_display_indexes` (line 263)
- `macos_window_ids` (line 277)
- `list_macos_windows` (line 306)
- `list_test_macos_windows` (line 322)
- `resolve_macos_windows` (line 333)
- `resolve_test_macos_windows` (line 340)
- `capture_macos` (line 347)
- `capture_linux` (line 369)
- `main` (line 420)

**Variables:**
- `SCRIPT_DIR` (line 16)
- `MAC_PERM_SCRIPT` (line 17)
- `MAC_PERM_HELPER` (line 18)
- `MAC_WINDOW_SCRIPT` (line 19)
- `MAC_DISPLAY_SCRIPT` (line 20)
- `TEST_MODE_ENV` (line 21)
- `TEST_PLATFORM_ENV` (line 22)
- `TEST_WINDOWS_ENV` (line 23)
- `TEST_DISPLAYS_ENV` (line 24)
- `TEST_PNG` (line 25)


### `skills/xlsx/scripts/office/helpers/__init__.py`

_No exported symbols detected._

### `skills/xlsx/scripts/office/helpers/merge_runs.py`

**Functions:**
- `merge_runs` (line 16)
- `_find_elements` (line 44)
- `_get_child` (line 59)
- `_get_children` (line 68)
- `_is_adjacent` (line 78)
- `_remove_elements` (line 93)
- `_strip_run_rsid_attrs` (line 99)
- `_merge_runs_in` (line 108)
- `_first_child_run` (line 128)
- `_next_element_sibling` (line 135)
- `_next_sibling_run` (line 144)
- `_is_run` (line 154)
- `_can_merge` (line 159)
- `_merge_run_content` (line 170)
- `_consolidate_text` (line 178)

**Methods:**
- `traverse` (line 47)


### `skills/xlsx/scripts/office/helpers/simplify_redlines.py`

**Functions:**
- `simplify_redlines` (line 22)
- `_merge_tracked_changes_in` (line 47)
- `_is_element` (line 75)
- `_get_author` (line 80)
- `_can_merge_tracked` (line 89)
- `_merge_tracked_content` (line 104)
- `_find_elements` (line 111)
- `get_tracked_change_authors` (line 126)
- `_get_authors_from_docx` (line 149)
- `infer_author` (line 172)

**Methods:**
- `traverse` (line 114)

**Variables:**
- `WORD_NS` (line 19)


### `skills/xlsx/scripts/office/pack.py`

**Functions:**
- `pack` (line 24)
- `_run_validation` (line 69)
- `_condense_xml` (line 108)


### `skills/xlsx/scripts/office/soffice.py`

**Functions:**
- `get_soffice_env` (line 24)
- `run_soffice` (line 35)
- `_needs_shim` (line 44)
- `_ensure_shim` (line 53)


### `skills/xlsx/scripts/office/unpack.py`

**Functions:**
- `unpack` (line 34)
- `_pretty_print_xml` (line 82)
- `_escape_smart_quotes` (line 91)

**Variables:**
- `SMART_QUOTE_REPLACEMENTS` (line 26)


### `skills/xlsx/scripts/office/validate.py`

**Functions:**
- `main` (line 25)


### `skills/xlsx/scripts/office/validators/__init__.py`

_No exported symbols detected._

### `skills/xlsx/scripts/office/validators/base.py`

**Classes:**
- `BaseSchemaValidator` (line 12)

**Methods:**
- `__init__` (line 94)
- `validate` (line 109)
- `repair` (line 112)
- `repair_whitespace_preservation` (line 115)
- `validate_xml` (line 143)
- `validate_namespaces` (line 170)
- `validate_unique_ids` (line 199)
- `validate_file_references` (line 289)
- `validate_all_relationship_ids` (line 385)
- `_get_expected_relationship_type` (line 469)
- `validate_content_types` (line 492)
- `validate_file_against_xsd` (line 598)
- `validate_against_xsd` (line 636)
- `_get_schema_path` (line 685)
- `_clean_ignorable_namespaces` (line 703)
- `_remove_ignorable_elements` (line 723)
- `_preprocess_for_mc_ignorable` (line 742)
- `_validate_single_file_xsd` (line 750)
- `_get_original_file_errors` (line 787)
- `_remove_template_tags_from_text_nodes` (line 814)
- `process_text_content` (line 821)


### `skills/xlsx/scripts/office/validators/docx.py`

**Classes:**
- `DOCXSchemaValidator` (line 16)

**Methods:**
- `validate` (line 24)
- `validate_whitespace_preservation` (line 66)
- `validate_deletions` (line 112)
- `count_paragraphs_in_unpacked` (line 163)
- `count_paragraphs_in_original` (line 179)
- `validate_insertions` (line 202)
- `compare_paragraph_counts` (line 243)
- `_parse_id_value` (line 251)
- `validate_id_constraints` (line 254)
- `validate_comment_markers` (line 298)
- `repair` (line 386)
- `repair_durableId` (line 391)


### `skills/xlsx/scripts/office/validators/pptx.py`

**Classes:**
- `PPTXSchemaValidator` (line 10)

**Methods:**
- `validate` (line 25)
- `validate_uuid_ids` (line 62)
- `_looks_like_uuid` (line 100)
- `validate_slide_layout_ids` (line 104)
- `validate_no_duplicate_slide_layouts` (line 172)
- `validate_notes_slide_references` (line 210)


### `skills/xlsx/scripts/office/validators/redlining.py`

**Classes:**
- `RedliningValidator` (line 11)

**Methods:**
- `__init__` (line 13)
- `repair` (line 22)
- `validate` (line 25)
- `_generate_detailed_diff` (line 104)
- `_get_git_word_diff` (line 127)
- `_remove_author_tracked_changes` (line 198)
- `_extract_text_content` (line 229)


### `skills/xlsx/scripts/recalc.py`

**Functions:**
- `has_gtimeout` (line 32)
- `setup_libreoffice_macro` (line 42)
- `recalc` (line 70)
- `main` (line 164)

**Variables:**
- `MACRO_DIR_MACOS` (line 17)
- `MACRO_DIR_LINUX` (line 18)
- `MACRO_FILENAME` (line 19)
- `RECALCULATE_MACRO` (line 21)


## Change Recipe

To add a new feature to the **skills** domain:

1. Update the model/schema in `src/skills/`
