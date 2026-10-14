import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { Combobox } from '../components/Combobox';
import { Mic, Square } from 'lucide-react';
import { parseTicketDictation } from '../lib/dictation';
import {
  DEPARTMENT_CATEGORY_ROOT,
  TICKET_DEPARTMENTS,
  type Category,
  type TicketDepartment,
  type Location,
} from '../lib/types';

const OTHER_SUBCATEGORY = '__other__';

interface SpeechRecognitionResultLike {
  0: { transcript: string };
}

interface SpeechRecognitionEventLike {
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionWindow = Window & {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
};

function normalizeCategoryName(name: string) {
  return name.toLowerCase().replace(/&/g, 'and').replace(/\s+/g, ' ').trim();
}

export default function NewTicket() {
  const { user, profile, role } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [categoryId, setCategoryId] = useState<string>('');
  const [subcategoryId, setSubcategoryId] = useState<string>('');
  const [otherSubcategory, setOtherSubcategory] = useState('');
  const [locationId, setLocationId] = useState<string>('');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [requestedFor, setRequestedFor] = useState('');
  const [photos, setPhotos] = useState<File[]>([]);
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const transcriptRef = useRef('');

  const managerDepartment = role === 'manager' && profile?.department &&
    TICKET_DEPARTMENTS.includes(profile.department as TicketDepartment)
    ? profile.department as TicketDepartment : null;
  const canUseVoice = !!managerDepartment;

  const categoriesQ = useQuery({
    queryKey: ['categories'],
    queryFn: async (): Promise<Category[]> => {
      if (!supabase) throw new Error('Supabase not configured');
      const { data, error } = await supabase
        .from('categories')
        .select('*')
        .eq('is_active', true)
        .order('name');
      if (error) throw error;
      return data as Category[];
    },
  });

  useEffect(() => {
    if (!managerDepartment || categoryId) return;
    const root = categoriesQ.data?.find((category) =>
      category.department === managerDepartment && category.parent_id === null &&
      normalizeCategoryName(category.name) === normalizeCategoryName(DEPARTMENT_CATEGORY_ROOT[managerDepartment]),
    );
    if (root) setCategoryId(root.id);
  }, [managerDepartment, categoryId, categoriesQ.data]);

  useEffect(() => () => {
    const recognition = recognitionRef.current;
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.stop();
    }
  }, []);

  const locationsQ = useQuery({
    queryKey: ['locations'],
    queryFn: async (): Promise<Location[]> => {
      if (!supabase) throw new Error('Supabase not configured');
      const { data, error } = await supabase
        .from('locations')
        .select('*')
        .eq('is_active', true)
        .order('building');
      if (error) throw error;
      return data as Location[];
    },
  });

  const submit = useMutation({
    mutationFn: async () => {
      if (!supabase || !user) throw new Error('Not ready');
      const selectedCategory = categoriesQ.data?.find((category) => category.id === categoryId);
      if (!selectedCategory) throw new Error('Select a department.');
      const { data, error } = await supabase
        .from('tickets')
        .insert({
          department: selectedCategory.department as TicketDepartment,
          category_id: categoryId || null,
          subcategory_id:
            subcategoryId && subcategoryId !== OTHER_SUBCATEGORY ? subcategoryId : null,
          legacy_subcategory:
            subcategoryId === OTHER_SUBCATEGORY ? otherSubcategory.trim() || null : null,
          location_id: locationId || null,
          subject,
          description,
          requested_for: requestedFor.trim() || null,
          submitter_id: user.id,
        })
        .select('id, ref')
        .single();
      if (error) throw error;
      const attachmentErrors: string[] = [];
      for (const photo of photos) {
        const extension = photo.type.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
        const storagePath = `tickets/${data.id}/${crypto.randomUUID()}.${extension}`;
        const { error: uploadError } = await supabase.storage
          .from('attachments')
          .upload(storagePath, photo, { contentType: photo.type, upsert: false });
        if (uploadError) {
          attachmentErrors.push(`${photo.name}: ${uploadError.message}`);
          continue;
        }
        const { error: metadataError } = await supabase.from('attachments').insert({
          ticket_id: data.id,
          storage_path: storagePath,
          mime_type: photo.type,
          size_bytes: photo.size,
          uploaded_by: user.id,
        });
        if (metadataError) {
          await supabase.storage.from('attachments').remove([storagePath]);
          attachmentErrors.push(`${photo.name}: ${metadataError.message}`);
        }
      }
      return { ...data, attachmentErrors };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['tickets'] });
      if (data.attachmentErrors.length > 0) {
        window.alert(`Ticket submitted, but some photos could not be attached:\n${data.attachmentErrors.join('\n')}`);
      }
      navigate(`/tickets/${data.id}`);
    },
    onError: (e: Error) => setError(e.message),
  });

  const categoryOptions = TICKET_DEPARTMENTS.flatMap((department) => {
    const root = categoriesQ.data?.find(
      (category) =>
        category.department === department &&
        category.parent_id === null &&
        normalizeCategoryName(category.name) ===
          normalizeCategoryName(DEPARTMENT_CATEGORY_ROOT[department]),
    );
    return root
      ? [{ value: root.id, label: DEPARTMENT_CATEGORY_ROOT[department] }]
      : [];
  });
  const filteredSubcategories =
    categoriesQ.data?.filter((category) => category.parent_id === categoryId && category.is_active) ?? [];

  function applyVoiceTranscript(transcript: string) {
    setVoiceTranscript(transcript);
    const fields = parseTicketDictation(transcript);
    if (fields.subject) setSubject(fields.subject);
    if (fields.description !== null) setDescription(fields.description);
    else setVoiceError('Subject captured. No Description separator was heard; enter the description below or try again.');
  }

  function toggleVoiceEntry() {
    if (!canUseVoice) return;
    if (voiceListening) {
      recognitionRef.current?.stop();
      return;
    }
    const SpeechRecognition = (window as SpeechRecognitionWindow).SpeechRecognition ??
      (window as SpeechRecognitionWindow).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setVoiceError('Voice entry is not supported in this browser. Try the latest Chrome or Edge.');
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';
    transcriptRef.current = '';
    setVoiceTranscript('');
    setVoiceError(null);
    recognition.onresult = (event) => {
      transcriptRef.current = Array.from(event.results, (result) => result[0].transcript).join(' ');
      setVoiceTranscript(transcriptRef.current);
    };
    recognition.onerror = (event) => {
      setVoiceError(event.error === 'not-allowed'
        ? 'Allow microphone access in your browser to use voice entry.'
        : `Voice entry stopped: ${event.error}.`);
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setVoiceListening(false);
      if (transcriptRef.current.trim()) applyVoiceTranscript(transcriptRef.current.trim());
    };
    recognitionRef.current = recognition;
    setVoiceListening(true);
    try {
      recognition.start();
    } catch (startError) {
      recognitionRef.current = null;
      setVoiceListening(false);
      setVoiceError(startError instanceof Error ? startError.message : 'Could not start voice entry.');
    }
  }

  return (
    <section className="mx-auto max-w-2xl">
      <h1 className="page-title">Submit a ticket</h1>
      <p className="page-subtitle">
        A team member will review your request and assign a priority and owner shortly.
      </p>

      {canUseVoice && (
        <div className="card-pad mb-5 space-y-3">
          <p className="text-base font-semibold text-brand-navy">Enter Subject and Description by voice</p>
          <ol className="list-inside list-decimal text-sm text-slate-600">
            <li>Press the green Start voice entry button.</li>
            <li>Say the subject first.</li>
            <li>Say <strong>Description:</strong> (or "description colon"), then describe the issue.</li>
            <li>Press the red Stop voice entry button, then review and edit both fields.</li>
          </ol>
          <p className="text-sm text-slate-600">Example: "Broken chair. Description: The chair in room 12 has a loose leg."</p>
          <p className="text-sm text-slate-600">Your department is selected automatically. Subcategory, location, and who the ticket is for are optional and entered manually.</p>
          <button
            type="button"
            onClick={toggleVoiceEntry}
            aria-pressed={voiceListening}
            className={`btn text-white ${voiceListening ? 'bg-red-700 hover:bg-red-800' : 'bg-green-700 hover:bg-green-800'}`}
          >
            {voiceListening ? <Square aria-hidden="true" size={20} /> : <Mic aria-hidden="true" size={20} />}
            {voiceListening ? 'Stop voice entry' : 'Start voice entry'}
          </button>
          {voiceListening && <p role="status" className="text-sm font-semibold text-red-700">Listening. Press Stop voice entry when finished.</p>}
          {voiceError && <p role="alert" className="alert-error">{voiceError}</p>}
          {voiceTranscript && <p className="whitespace-pre-wrap text-xs text-slate-500">Transcript: {voiceTranscript}</p>}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (!voiceListening) submit.mutate();
        }}
        className="card-pad space-y-6"
      >
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div>
            <label htmlFor="category" className="field-label">
              Department
            </label>
            <Combobox
              id="category"
              options={categoryOptions}
              value={categoryId}
              onChange={(v) => {
                setCategoryId(v);
                setSubcategoryId('');
                setOtherSubcategory('');
              }}
              placeholder="Select a department..."
            />
          </div>

          <div>
            <label htmlFor="subcategory" className="field-label">
              Subcategory (optional)
            </label>
            <select
              id="subcategory"
              disabled={!categoryId}
              value={subcategoryId}
              onChange={(event) => {
                setSubcategoryId(event.target.value);
                setOtherSubcategory('');
              }}
              className="field-select"
            >
              <option value="">Select a subcategory</option>
              {filteredSubcategories.map((category) => (
                <option key={category.id} value={category.id}>{category.name}</option>
              ))}
              {categoryId && <option value={OTHER_SUBCATEGORY}>Other</option>}
            </select>
          </div>

          {subcategoryId === OTHER_SUBCATEGORY && (
            <div>
              <label htmlFor="other-subcategory" className="field-label">
                Other subcategory
              </label>
              <input
                id="other-subcategory"
                maxLength={200}
                value={otherSubcategory}
                onChange={(event) => setOtherSubcategory(event.target.value)}
                placeholder="Enter a subcategory"
                className="field"
              />
            </div>
          )}

          <div>
            <label htmlFor="location" className="field-label">
              Location (optional)
            </label>
            <Combobox
              id="location"
              options={(locationsQ.data ?? []).map((l) => ({ value: l.id, label: l.label }))}
              value={locationId}
              onChange={setLocationId}
              placeholder="Type to search locations…"
            />
          </div>
        </div>

        <div>
          <label htmlFor="subject" className="field-label">
            Subject
          </label>
          <input
            id="subject"
            required
            maxLength={200}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Projector in Room 101 won't turn on"
            className="field"
          />
        </div>

        <div>
          <label htmlFor="description" className="field-label">
            Description
          </label>
          <textarea
            id="description"
            required
            rows={6}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Please describe the issue, what you've already tried, and how urgent it is."
            className="field resize-y"
          />
        </div>

        <div>
          <label htmlFor="requested-for" className="field-label">Who is this ticket for? (optional)</label>
          <input
            id="requested-for"
            maxLength={200}
            value={requestedFor}
            onChange={(event) => setRequestedFor(event.target.value)}
            placeholder="Name or department"
            className="field"
          />
        </div>

        <div>
          <span className="field-label">Photos</span>
          <label className="btn-secondary inline-flex cursor-pointer items-center">
            Take or choose photos
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              capture="environment"
              multiple
              className="sr-only"
              onChange={(event) => {
                const selected = Array.from(event.target.files ?? []);
                setPhotos((current) => [...current, ...selected].slice(0, 3));
                event.target.value = '';
              }}
            />
          </label>
          <p className="mt-1 text-xs text-slate-500">Up to 3 images, 10 MB each.</p>
          {photos.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm text-slate-600">
              {photos.map((photo, index) => (
                <li key={`${photo.name}-${photo.lastModified}`} className="flex items-center justify-between gap-3">
                  <span className="truncate">{photo.name}</span>
                  <button type="button" onClick={() => setPhotos((current) => current.filter((_, i) => i !== index))} className="text-xs text-rose-700 hover:underline">Remove</button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && (
          <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={() => navigate(-1)} className="btn-ghost">
            Cancel
          </button>
          <button type="submit" disabled={submit.isPending || voiceListening} className="btn-primary">
            {submit.isPending ? 'Submitting…' : 'Submit ticket'}
          </button>
        </div>
      </form>
    </section>
  );
}
