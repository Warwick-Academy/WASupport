alter table public.av_request_files
  drop constraint if exists av_request_files_size_bytes_check;

alter table public.av_request_files
  add constraint av_request_files_size_bytes_check
  check (size_bytes > 0 and size_bytes <= 30 * 1024 * 1024);

update storage.buckets
   set file_size_limit = 30 * 1024 * 1024
 where id = 'av-request-files';