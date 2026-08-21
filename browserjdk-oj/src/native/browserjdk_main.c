/*
 * Copyright (c) 2026 Mini-OJ contributors.
 *
 * GNU General Public License version 2 only, with the Classpath Exception.
 * See LICENSE in the BrowserJDK source distribution.
 */
#include <emscripten.h>
#include <emscripten/threading.h>
#include <jni.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define RING_CAPACITY (2u * 1024u * 1024u)

typedef struct {
  _Atomic uint32_t write_index;
  _Atomic uint32_t read_index;
  _Atomic uint32_t closed;
  _Atomic uint32_t interrupt;
  _Atomic uint32_t signal;
  uint32_t capacity;
  uint8_t data[RING_CAPACITY];
} BrowserRing;

/* Deliberately distinct objects: protocol traffic can never consume System.in. */
static BrowserRing control_request = {.capacity = RING_CAPACITY};
static BrowserRing control_response = {.capacity = RING_CAPACITY};
static BrowserRing program_stdin = {.capacity = RING_CAPACITY};
static _Atomic uint32_t runtime_stage;

static uint32_t ring_available(BrowserRing *ring) {
  uint32_t write = atomic_load_explicit(&ring->write_index, memory_order_acquire);
  uint32_t read = atomic_load_explicit(&ring->read_index, memory_order_acquire);
  return write - read;
}

static void ring_notify(BrowserRing *ring) {
  atomic_fetch_add_explicit(&ring->signal, 1, memory_order_release);
  emscripten_futex_wake((void *)&ring->signal, INT32_MAX);
}

static void ring_reset(BrowserRing *ring) {
  atomic_store(&ring->write_index, 0);
  atomic_store(&ring->read_index, 0);
  atomic_store(&ring->closed, 0);
  atomic_store(&ring->interrupt, 0);
  ring_notify(ring);
}

static int ring_write(BrowserRing *ring, const uint8_t *src, int length) {
  int written = 0;
  while (written < length) {
    if (atomic_load_explicit(&ring->interrupt, memory_order_acquire)) return -2;
    uint32_t write = atomic_load_explicit(&ring->write_index, memory_order_relaxed);
    uint32_t read = atomic_load_explicit(&ring->read_index, memory_order_acquire);
    uint32_t space = ring->capacity - (write - read);
    if (space == 0) return written;
    uint32_t count = (uint32_t)(length - written);
    if (count > space) count = space;
    uint32_t slot = write % ring->capacity;
    uint32_t first = ring->capacity - slot;
    if (first > count) first = count;
    memcpy(ring->data + slot, src + written, first);
    memcpy(ring->data, src + written + first, count - first);
    atomic_store_explicit(&ring->write_index, write + count, memory_order_release);
    written += (int)count;
    ring_notify(ring);
  }
  return written;
}

static int ring_write_blocking(BrowserRing *ring, const uint8_t *src, int length) {
  int written = 0;
  while (written < length) {
    int count = ring_write(ring, src + written, length - written);
    if (count < 0) return count;
    written += count;
    if (written == length) break;
    uint32_t observed = atomic_load_explicit(&ring->signal, memory_order_acquire);
    if (ring_available(ring) == ring->capacity) {
      emscripten_futex_wait((void *)&ring->signal, observed, 100.0);
    }
  }
  return written;
}

static int ring_read(BrowserRing *ring, uint8_t *dst, int length, int block) {
  for (;;) {
    uint32_t available = ring_available(ring);
    if (available) {
      uint32_t read = atomic_load_explicit(&ring->read_index, memory_order_relaxed);
      uint32_t count = (uint32_t)length;
      if (count > available) count = available;
      uint32_t slot = read % ring->capacity;
      uint32_t first = ring->capacity - slot;
      if (first > count) first = count;
      memcpy(dst, ring->data + slot, first);
      memcpy(dst + first, ring->data, count - first);
      atomic_store_explicit(&ring->read_index, read + count, memory_order_release);
      ring_notify(ring);
      return (int)count;
    }
    if (atomic_load_explicit(&ring->interrupt, memory_order_acquire)) return -2;
    if (atomic_load_explicit(&ring->closed, memory_order_acquire)) return 0;
    if (!block) return 0;
    uint32_t observed = atomic_load_explicit(&ring->signal, memory_order_acquire);
    emscripten_futex_wait((void *)&ring->signal, observed, 100.0);
  }
}

EMSCRIPTEN_KEEPALIVE int browserjdk_control_write(const uint8_t *src, int length) {
  return ring_write(&control_request, src, length);
}

EMSCRIPTEN_KEEPALIVE int browserjdk_control_response_available(void) {
  return (int)ring_available(&control_response);
}

EMSCRIPTEN_KEEPALIVE int browserjdk_debug_state(void) {
  return (int)(atomic_load(&runtime_stage) * 10000000u
      + ring_available(&control_request) * 1000u
      + ring_available(&control_response));
}

EMSCRIPTEN_KEEPALIVE int browserjdk_runtime_stage(void) {
  return (int)atomic_load(&runtime_stage);
}

EMSCRIPTEN_KEEPALIVE int browserjdk_control_response_read(uint8_t *dst, int length) {
  return ring_read(&control_response, dst, length, 0);
}

EMSCRIPTEN_KEEPALIVE void browserjdk_program_stdin_reset(void) {
  ring_reset(&program_stdin);
}

EMSCRIPTEN_KEEPALIVE int browserjdk_program_stdin_write(const uint8_t *src, int length) {
  return ring_write(&program_stdin, src, length);
}

EMSCRIPTEN_KEEPALIVE void browserjdk_program_stdin_close(void) {
  atomic_store_explicit(&program_stdin.closed, 1, memory_order_release);
  ring_notify(&program_stdin);
}

EMSCRIPTEN_KEEPALIVE void browserjdk_request_interrupt(void) {
  atomic_store(&control_request.interrupt, 1);
  atomic_store(&control_response.interrupt, 1);
  atomic_store(&program_stdin.interrupt, 1);
  ring_notify(&control_request);
  ring_notify(&control_response);
  ring_notify(&program_stdin);
}

/* Hooks required by the licensed OpenJDK Emscripten io_util_md.c port. */
int jvm_use_ring_buffer_stdin(void) { return 1; }

int stdin_read_byte(void) {
  uint8_t byte = 0;
  int result = ring_read(&program_stdin, &byte, 1, 1);
  return result == 1 ? (int)byte : -1;
}

int jvm_stdin_available(void) { return (int)ring_available(&program_stdin); }

JNIEXPORT jint JNICALL
Java_org_minioj_browserjdk_CompileServer_controlRead(JNIEnv *env, jclass type,
                                                      jbyteArray target,
                                                      jint offset, jint length) {
  (void)type;
  if (length <= 0) return 0;
  jbyte *bytes = (*env)->GetByteArrayElements(env, target, NULL);
  if (!bytes) return -1;
  if (atomic_load(&runtime_stage) < 6) atomic_store(&runtime_stage, 5);
  int result = ring_read(&control_request, (uint8_t *)bytes + offset, length, 1);
  if (result > 0) (*env)->ReleaseByteArrayElements(env, target, bytes, 0);
  else (*env)->ReleaseByteArrayElements(env, target, bytes, JNI_ABORT);
  return result > 0 ? result : -1;
}

JNIEXPORT void JNICALL
Java_org_minioj_browserjdk_CompileServer_controlWrite(JNIEnv *env, jclass type,
                                                       jbyteArray source,
                                                       jint offset, jint length) {
  (void)type;
  atomic_store(&runtime_stage, 6);
  jbyte *bytes = (*env)->GetByteArrayElements(env, source, NULL);
  if (!bytes) return;
  (void)ring_write_blocking(&control_response, (uint8_t *)bytes + offset, length);
  (*env)->ReleaseByteArrayElements(env, source, bytes, JNI_ABORT);
}

/*
 * The Emscripten target uses the Linux FileDispatcherImpl class but has no
 * copy_file_range/sendfile backend to initialise. FileChannel still needs the
 * platform init symbol while opening the jimage; all ordinary I/O is supplied
 * by UnixFileDispatcherImpl from libnio.
 */
JNIEXPORT void JNICALL
Java_sun_nio_ch_FileDispatcherImpl_init0(JNIEnv *env, jclass type) {
  (void)env;
  (void)type;
}

static int start_compile_server(JavaVM *vm, JNIEnv *env) {
  (void)vm;
  jclass server = (*env)->FindClass(env, "org/minioj/browserjdk/CompileServer");
  if (!server) { (*env)->ExceptionDescribe(env); return 3; }
  atomic_store(&runtime_stage, 3);
  JNINativeMethod control_methods[] = {
      {.name = "controlRead", .signature = "([BII)I",
       .fnPtr = (void *)Java_org_minioj_browserjdk_CompileServer_controlRead},
      {.name = "controlWrite", .signature = "([BII)V",
       .fnPtr = (void *)Java_org_minioj_browserjdk_CompileServer_controlWrite},
  };
  if ((*env)->RegisterNatives(env, server, control_methods,
                              (jint)(sizeof(control_methods) / sizeof(control_methods[0]))) != 0) {
    (*env)->ExceptionDescribe(env);
    return 4;
  }
  jmethodID main_method = (*env)->GetStaticMethodID(env, server, "main", "([Ljava/lang/String;)V");
  if (!main_method) { (*env)->ExceptionDescribe(env); return 5; }
  jclass string_class = (*env)->FindClass(env, "java/lang/String");
  jobjectArray args = (*env)->NewObjectArray(env, 0, string_class, NULL);
  atomic_store(&runtime_stage, 4);
  (*env)->CallStaticVoidMethod(env, server, main_method, args);
  if ((*env)->ExceptionCheck(env)) { (*env)->ExceptionDescribe(env); return 6; }
  return 0;
}

int main(void) {
  JavaVM *vm = NULL;
  JNIEnv *env = NULL;
  JavaVMOption options[] = {
      {.optionString = "-Djava.home=/opt/jdk"},
      {.optionString = "-Djava.class.path=/opt/browserjdk"},
      {.optionString = "-Dfile.encoding=UTF-8"},
      {.optionString = "-Duser.language=en"},
      {.optionString = "-Duser.country=US"},
      {.optionString = "-Xint"},
      {.optionString = "-XX:+UseSerialGC"},
      {.optionString = "-XX:MaxHeapSize=268435456"},
  };
  JavaVMInitArgs args = {
      .version = JNI_VERSION_10,
      .nOptions = (jint)(sizeof(options) / sizeof(options[0])),
      .options = options,
      .ignoreUnrecognized = JNI_TRUE,
  };
  ring_reset(&control_request);
  ring_reset(&control_response);
  ring_reset(&program_stdin);
  atomic_store(&runtime_stage, 1);
  jint created = JNI_CreateJavaVM(&vm, (void **)&env, &args);
  if (created != JNI_OK) {
    fprintf(stderr, "BrowserJDK: JNI_CreateJavaVM failed: %d\n", created);
    return 2;
  }
  atomic_store(&runtime_stage, 2);
  return start_compile_server(vm, env);
}
